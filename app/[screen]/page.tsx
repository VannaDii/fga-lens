import { notFound } from "next/navigation";

import { screen } from "@/lib/workbench-contract";

/** Generate the URLs shown in the shared workbench shell. */
export function generateStaticParams() {
  return Object.keys(screen.keys).map((screen) => ({ screen }));
}

/** Reject paths outside the supported navigation destinations. */
export default async function WorkbenchPage({ params }: { params: Promise<{ screen: string }> }) {
  if (!screen.is((await params).screen)) notFound();
  return null;
}
