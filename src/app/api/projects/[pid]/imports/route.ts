import { ImportFieldsSchema } from "@shared/contract";
import { badRequest } from "@/server/http/api-error";
import { route } from "@/server/http/route";
import { listImports, MAX_UPLOAD_BYTES, uploadImport } from "@/server/services/imports";

export const runtime = "nodejs";
export const maxDuration = 60; // parsing a large workbook takes a few seconds

type P = { pid: string };
export const GET = route<P>(async (_req, { pid }) => listImports(pid));

/** multipart: `file` (.xlsx) + optional `planTo`. Window = project today → planTo. Stages; writes nothing live. */
export const POST = route<P>(async (req, { pid }) => {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw badRequest("Send the file as multipart/form-data in the field `file`.");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw badRequest("Missing the `file` field.");
  if (file.size > MAX_UPLOAD_BYTES) throw badRequest("Files must be 4 MB or smaller.");
  const planTo = form.get("planTo");
  const fields = ImportFieldsSchema.parse({ planTo: typeof planTo === "string" && planTo ? planTo : undefined });
  const bytes = new Uint8Array(await file.arrayBuffer());
  return uploadImport(pid, file.name || "upload.xlsx", bytes, { planTo: fields.planTo });
}, { status: 201 });
