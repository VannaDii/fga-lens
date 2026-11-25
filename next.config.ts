import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  redirects() {
    return [{ source: "/access-review", destination: "/explore", permanent: false }];
  },
};

export default nextConfig;
