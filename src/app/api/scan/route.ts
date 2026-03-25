import { NextRequest, NextResponse } from "next/server";
import puppeteer from "puppeteer-core";
import { getBrowserlessConnection } from "@/lib/browserless";
import * as axe from "axe-core";

const DOCKER_CHROME_PATH = "/usr/bin/google-chrome-stable";
const LOCAL_CHROME_PATH = process.platform === 'win32' 
    ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" 
    : "/usr/bin/google-chrome-stable";

const generateId = () => Math.random().toString(36).substr(2, 9);

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
            const executablePath = configuredPath || (isProduction ? DOCKER_CHROME_PATH : LOCAL_CHROME_PATH);
            browser = await puppeteer.launch({
                args: [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                    "--single-process",
                    "--no-zygote",
                ],
                executablePath,
                headless: true,
            });
        }

        const page = await browser.newPage();
        await page.setDefaultNavigationTimeout(60000);
        
        // Website par jana
        await page.goto(url, { waitUntil: "networkidle2" });

        // Inject axe-core source directly into the page and run it via evaluate()
        // This bypasses @axe-core/puppeteer which fails on Windows paths with spaces
        await page.evaluate((source) => {
            const script = document.createElement('script');
            script.innerHTML = source;
            document.head.appendChild(script);
        }, axe.source);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const results = await page.evaluate(() => (window as any).axe.run()) as axe.AxeResults;

        const issues = results.violations.map((v) => ({
            id: generateId(),
            category: "Accessibility",
            name: v.help,
            description: v.description,
            severity: v.impact === "critical" || v.impact === "serious" ? "High" : "Medium",
            affectedElements: v.nodes.map((node) => node.html.substring(0, 200)),
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
        if (browser) await browser.close();
    }
}

export async function POST(request: NextRequest) {
    try {
        const { url } = await request.json();
        if (!url) return NextResponse.json({ error: "URL is required" }, { status: 400 });

        const normalizedUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
        
        try {
            new URL(normalizedUrl);
        } catch {
            return NextResponse.json({ error: "Please enter a valid URL" }, { status: 400 });
        }

        const result = await scanWebsite(normalizedUrl);
        return NextResponse.json(result);
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : "Failed to scan website";
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}