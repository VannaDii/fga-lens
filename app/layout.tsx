import type { Metadata } from "next";
import { Workbench } from "@/components/workbench";
import "@xyflow/react/dist/style.css";
import "./globals.css";

/** Metadata for the model, instance, query and regression screens. */
export const metadata: Metadata = {
  title: "FGA Lens — OpenFGA workbench",
  description: "Author OpenFGA models, explore relationships and run authorization regressions.",
};

/** Hold the workbench state above route transitions. */
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body><Workbench>{children}</Workbench></body>
    </html>
  );
}
