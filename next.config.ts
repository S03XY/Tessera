import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pg", "@hiero-ledger/sdk", "@x402/hedera"],
};

export default nextConfig;
