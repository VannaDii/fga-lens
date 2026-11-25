import { WorkbenchModelSource } from "@/components/workbench-model-source";
import { decode, modelSourceLine, target } from "@/lib/workbench-contract";

/** Open a published definition without selecting or loading it into the draft. */
export default async function ModelSourcePage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const binding = decode(target, { store: params.store, revision: params.revision });
  const line = decode(modelSourceLine, typeof params.line === "string" ? Number(params.line) : null);
  if (!binding || line === null) return <p className="wb-notice" role="alert">This model source link is incomplete. Open the rule again from Query.</p>;
  return <WorkbenchModelSource key={`${binding.store}/${binding.revision}/${line}`} target={binding} line={line} />;
}
