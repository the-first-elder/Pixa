import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'WorldLens',
  description: 'Phone video to explorable 3D environments, navigated by natural language.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
