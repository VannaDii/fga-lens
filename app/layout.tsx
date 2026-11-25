import type { Metadata, Viewport } from "next";
import { Workbench } from "@/components/workbench";
import { chromeTint } from "@/lib/workbench-appearance";
import "@xyflow/react/dist/style.css";
import "./globals.css";

/** Metadata for the model, instance, query and regression screens. */
export const metadata: Metadata = {
  title: "FGA Playground — OpenFGA workbench",
  description: "Author OpenFGA models, explore relationships and run authorization regressions.",
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: chromeTint.light },
    { media: "(prefers-color-scheme: dark)", color: chromeTint.dark },
  ],
};

/** Hold the workbench state above route transitions. */
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body><Workbench>{children}</Workbench></body>
    </html>
  );
}
