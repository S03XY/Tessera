import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  serverExternalPackages: ["pg", "@hiero-ledger/sdk", "@x402/hedera"],
};

export default nextConfig;
