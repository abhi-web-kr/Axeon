import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    images: {
        remotePatterns: [
            {
                protocol: "https",
                hostname: "**",
            },
        ],
    },
    output: "standalone",
    serverExternalPackages: [
        "puppeteer-core",
        "axe-core",
    ],
};

export default nextConfig;
