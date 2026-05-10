import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://fractask.ai'),
  title: 'Fractask',
  description: 'Open-source task tree for humans and AI. Built around the Fractask method.',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'Fractask', statusBarStyle: 'black-translucent' },
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
  openGraph: {
    title: 'Fractask',
    description: 'Open-source task tree for humans and AI. Built around the Fractask method.',
    url: 'https://fractask.ai',
    siteName: 'Fractask',
    images: [
      {
        url: '/marketing/fractask-book-cover-v2-20260508-023007.jpg',
        width: 1408,
        height: 768,
        alt: 'Fractask — On the way, Vol. I',
      },
    ],
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Fractask',
    description: 'Open-source task tree for humans and AI. Built around the Fractask method.',
    images: ['/marketing/fractask-book-cover-v2-20260508-023007.jpg'],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0a0a0a',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage.getItem('getshit:theme');var t=s||(window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');if(t==='light')document.documentElement.classList.add('light');}catch(e){}})();`,
          }}
        />
      </head>
      <body>
        {children}
        <script
          dangerouslySetInnerHTML={{
            __html: `if ('serviceWorker' in navigator) { window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); }); }`,
          }}
        />
      </body>
    </html>
  );
}
