/** @type {import('next').NextConfig} */
const nextConfig = {
  // Gaussian-splat assets are large; never bundle them. Served from /public/assets (dev)
  // or object storage via signed URLs (prod).
};

export default nextConfig;
