import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lets a second dev server (e.g. real DB next to mock mode) run from the same folder: NEXT_DIST_DIR=.next-real
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
