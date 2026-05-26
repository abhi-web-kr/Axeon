import { NextRequest, NextResponse } from "next/server";
import puppeteer from "puppeteer-core";
import { getBrowserlessConnection } from "@/lib/browserless";
import * as axe from "axe-core";

const DOCKER_CHROME_PATH = "/usr/bin/google-chrome-stable";
const LOCAL_CHROME_PATH =
    process.platform === "win32"
        ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
        : "/usr/bin/google-chrome-stable";

const generateId = () => Math.random().toString(36).substring(2, 11);

type AxeWindow = Window & {
    axe?: {
        run: () => Promise<axe.AxeResults>;
    };
};

async function scanWebsite(url: string) {
    let browser;
    try {
        const isProduction = process.env.NODE_ENV === "production";
        const hasBrowserlessToken = Boolean(process.env.BROWSERLESS_TOKEN);
        const configuredPath = process.env.CHROME_EXECUTABLE_PATH;

        // Browser Launch Logic
        if (isProduction && hasBrowserlessToken) {
            browser = await getBrowserlessConnection();
        } else {
            const executablePath =
                configuredPath ||
                (isProduction ? DOCKER_CHROME_PATH : LOCAL_CHROME_PATH);
            const launchOptions: Parameters<typeof puppeteer.launch>[0] & {
                ignoreHTTPSErrors: boolean;
            } = {
                args: [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                    "--single-process",
                    "--no-zygote",
                    "--ignore-certificate-errors",
                ],
                ignoreHTTPSErrors: true,
                executablePath,
                headless: true,
            };

            browser = await puppeteer.launch(launchOptions);
        }

        const page = await browser.newPage();
        await page.setDefaultNavigationTimeout(60000);

        // Navigation with explicit error handling
        try {
            await page.goto(url, { waitUntil: "networkidle2" });
        } catch (navErr) {
            throw new Error(
                `Navigation error for ${url}: ${(navErr as Error).message || String(navErr)}`,
            );
        }

        // Inject axe-core using Puppeteer's helper to reduce CSP issues
        try {
            await page.evaluate((axeSource) => {
                // window.eval runs the stringified axe-core code in the global context
                window.eval(axeSource);
            }, axe.source);

            // Verify axe is available on the window
            const hasAxe = await page.evaluate(
                () => !!(window as AxeWindow).axe,
            );
            if (!hasAxe) {
                throw new Error("Axe injection failed or was blocked by CSP");
            }
        } catch (injectErr) {
            throw new Error(
                `Failed to inject axe-core: ${(injectErr as Error).message || String(injectErr)}`,
            );
        }

        const results = (await page.evaluate(() => {
            const windowWithAxe = window as AxeWindow;

            if (!windowWithAxe.axe) {
                throw new Error("Axe is not available on the page");
            }

            return windowWithAxe.axe.run();
        })) as axe.AxeResults;

        const issues = results.violations.map((v) => ({
            id: generateId(),
            category: "Accessibility",
            name: v.help,
            description: v.description,
            severity:
                v.impact === "critical" || v.impact === "serious"
                    ? "High"
                    : v.impact === "moderate"
                      ? "Medium"
                      : "Low",
            affectedElements: v.nodes.map((node) =>
                node.html.substring(0, 200),
            ),
            remediation: `${v.help}. Check here: ${v.helpUrl}`,
        }));

        const issuesBySeverity = {
            high: issues.filter((i) => i.severity === "High").length,
            medium: issues.filter((i) => i.severity === "Medium").length,
            low: issues.filter((i) => i.severity === "Low").length,
        };

        return {
            url,
            scannedAt: new Date().toISOString(),
            totalIssues: issues.length,
            issuesBySeverity,
            issues,
        };
    } catch (error: unknown) {
        console.error("❌ Scan Error Details:", error);
        throw error;
    } finally {
        if (browser) {
            try {
                await browser.close();
            } catch (closeErr) {
                // Log close errors but do not override the original error
                console.error("Failed to close browser:", closeErr);
            }
        }
    }
}

export async function POST(request: NextRequest) {
    try {
        let body;
        try {
            body = await request.json();
        } catch {
            return NextResponse.json(
                { error: "Invalid JSON payload" },
                { status: 400 },
            );
        }

        const { url } = body;
        if (!url)
            return NextResponse.json(
                { error: "URL is required" },
                { status: 400 },
            );

        const normalizedUrl = /^https?:\/\//i.test(url)
            ? url
            : `https://${url}`;

        try {
            new URL(normalizedUrl);
        } catch {
            return NextResponse.json(
                { error: "Please enter a valid URL" },
                { status: 400 },
            );
        }

        const result = await scanWebsite(normalizedUrl);
        return NextResponse.json(result);
    } catch (error: unknown) {
        const errorMessage =
            error instanceof Error ? error.message : "Failed to scan website";
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}
