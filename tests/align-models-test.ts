import {
  ALIGN_MODELS,
  alignModelFor,
  uniqueAlignModelIds,
} from "../lib/alignModels";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

{
  assert(alignModelFor("en")?.id === ALIGN_MODELS.en!.id, "en has an aligner");
  assert(alignModelFor("es")?.id === ALIGN_MODELS.es!.id, "es has an aligner");
  assert(alignModelFor("fr")?.normalize === "latin-lower", "fr uses MMS folding");
  assert(alignModelFor("de")?.id === alignModelFor("es")?.id, "eu langs share MMS");
  assert(alignModelFor("zh")?.normalize === "cjk", "zh uses CJK normalize");
  assert(alignModelFor("en")?.normalize === "latin-upper", "en stays uppercase");
  assert(alignModelFor(undefined) === null, "missing language → no CTC");
  assert(alignModelFor("xx") === null, "unknown language → no CTC");

  const ids = uniqueAlignModelIds();
  assert(ids.length === 3, `expected 3 unique model ids, got ${ids.length}: ${ids}`);
  assert(ids.includes(ALIGN_MODELS.en!.id), "english model listed");
  assert(ids.includes(ALIGN_MODELS.es!.id), "mms model listed");
  assert(ids.includes(ALIGN_MODELS.zh!.id), "chinese model listed");
  console.log("align model map: ok", ids);
}

console.log("ALL ALIGN MODEL TESTS PASSED");
