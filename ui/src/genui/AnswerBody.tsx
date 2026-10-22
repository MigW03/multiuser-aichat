import { hasGeneratedUi } from "@mc/shared";
import { lazy, Suspense, useMemo } from "react";
import { Markdown } from "../components/Markdown.tsx";

/** The generated-UI renderer (OpenUI) loads only once some text has a visual in it. */
const GeneratedAnswer = lazy(() => import("./GeneratedAnswer.tsx").then((m) => ({ default: m.GeneratedAnswer })));

/** Markdown, or Markdown with visuals when the text has an openui-lang block (an AI answer, or a note saved from one). */
export function AnswerBody({ text, streaming = false, onDraft }: { text: string; streaming?: boolean; onDraft?: (text: string) => void }) {
  const visual = useMemo(() => hasGeneratedUi(text), [text]);
  if (!visual) return <Markdown text={text} />;
  return (
    <Suspense fallback={<Markdown text={text} />}>
      <GeneratedAnswer text={text} streaming={streaming} {...(onDraft ? { onDraft } : {})} />
    </Suspense>
  );
}
