import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { BrandPreviewBanner } from "@/components/branding/BrandPreviewBanner";
import { BrandProvider } from "@/components/branding/BrandProvider";
import { ThemeProvider } from "@/components/theme-provider";
import { ToastProvider } from "@/components/ui/Toast";
import { buildBrandCssProperties } from "@/lib/branding/cssVariables.server";
import { getRequestBrand } from "@/lib/branding/requestBrand.server";
import { WebsiteAnalytics } from "@/components/marketing/website-analytics";

const socialPreview = {
  url: "/social-preview.png",
  width: 1200,
  height: 630,
  alt: "SimplAssist",
};

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

const description = "AI-powered customer support assistant";

export async function generateMetadata(): Promise<Metadata> {
  const requestBrand = await getRequestBrand();
  const { brand } = requestBrand;
  const isPartner = brand.kind === "partner";
  const title =
    requestBrand.source === "partner_host" || requestBrand.isPreview
      ? brand.name
      : "SimplAssist";
  const metadataBase = new URL(
    (isPartner && brand.publicOrigin) ||
      process.env.NEXT_PUBLIC_APP_URL ||
      "https://simplassist.com",
  );

  return {
    metadataBase,
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
      ...(!isPartner ? { images: [socialPreview] } : {}),
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      ...(!isPartner ? { images: [socialPreview.url] } : {}),
    },
    ...(!isPartner
      ? {
          icons: {
            icon: [{ url: "/favicon-2.png", type: "image/png" }],
            apple: [{ url: "/favicon-2.png", type: "image/png" }],
          },
        }
      : brand.faviconUrl
        ? {
            icons: {
              icon: [{ url: brand.faviconUrl }],
              apple: [{ url: brand.faviconUrl }],
            },
          }
        : {}),
    ...(requestBrand.isPreview
      ? { robots: { index: false, follow: false } }
      : {}),
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const requestBrand = await getRequestBrand();
  const brandStyle = buildBrandCssProperties(requestBrand.brand);

  return (
    <html
      lang="en"
      style={brandStyle}
      suppressHydrationWarning
    >
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <BrandProvider requestBrand={requestBrand}>
          <ThemeProvider
            attribute="class"
            defaultTheme="light"
            enableSystem
            disableTransitionOnChange
          >
            <BrandPreviewBanner />
            <ToastProvider>{children}</ToastProvider>
            {requestBrand.source === "default" && !requestBrand.isPreview &&
              process.env.GOOGLE_ANALYTICS_MEASUREMENT_ID ? (
                <WebsiteAnalytics measurementId={process.env.GOOGLE_ANALYTICS_MEASUREMENT_ID} />
              ) : null}
          </ThemeProvider>
        </BrandProvider>
      </body>
    </html>
  );
}
