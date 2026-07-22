/**
 * Builds up to three short follow-up prompts from the latest assistant reply.
 * Heuristic only — no extra model call.
 */
export function buildFollowUpSuggestions(agentText: string, locale: "ja" | "en" = "ja"): string[] {
  const text = agentText.trim();
  if (!text) return defaultSuggestions(locale);

  const fromQuestions = extractQuestions(text).slice(0, 3);
  if (fromQuestions.length >= 3) return fromQuestions.slice(0, 3);

  const fromHeadings = extractOutlinePrompts(text, locale);
  const merged = uniqueStrings([...fromQuestions, ...fromHeadings, ...contextualDefaults(text, locale)]);
  return merged.slice(0, 3);
}

function extractQuestions(text: string): string[] {
  const lines = text.split(/\n+/).map((line) => line.replace(/^[-*•\d.)\s]+/, "").trim());
  const questions = lines.filter((line) => /[?？]$/.test(line) && line.length >= 8 && line.length <= 80);
  return uniqueStrings(questions);
}

function extractOutlinePrompts(text: string, locale: "ja" | "en"): string[] {
  const headings = [...text.matchAll(/^#{1,3}\s+(.+)$/gm)].map((match) => match[1]!.trim()).filter((line) => line.length >= 4 && line.length <= 60);
  return headings.slice(0, 3).map((heading) => (
    locale === "ja" ? `「${heading}」についてもう少し詳しく` : `Explain more about “${heading}”`
  ));
}

function contextualDefaults(text: string, locale: "ja" | "en"): string[] {
  const lower = text.toLowerCase();
  if (locale === "ja") {
    const out = ["次にやるべきことを3つに要約して", "リスクや注意点を教えて", "具体的な手順をステップで書いて"];
    if (/コード|実装|typescript|python|api|bug|エラー/.test(lower) || /エラー|実装|修正/.test(text)) {
      return ["この変更のテスト観点を列挙して", "想定される失敗ケースは？", "より安全な実装案はある？"];
    }
    if (/調査|比較|レビュー|分析/.test(text)) {
      return ["結論を1段落で要約して", "反対意見や代替案は？", "次の調査項目を3つ提案して"];
    }
    return out;
  }
  const out = ["Summarize the next three actions", "What are the risks?", "Write concrete steps"];
  if (/code|implement|typescript|python|api|bug|error/.test(lower)) {
    return ["List test cases for this change", "What failure modes should we expect?", "Is there a safer approach?"];
  }
  if (/research|compare|review|analy/.test(lower)) {
    return ["Summarize the conclusion in one paragraph", "What are the counterarguments?", "Suggest three next research items"];
  }
  return out;
}

function defaultSuggestions(locale: "ja" | "en"): string[] {
  return locale === "ja"
    ? ["もう少し詳しく説明して", "具体例を挙げて", "次に何をすべき？"]
    : ["Explain a bit more", "Give a concrete example", "What should I do next?"];
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}
