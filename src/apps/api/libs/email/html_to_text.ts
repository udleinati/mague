// Conversão HTML → texto plano para a parte `text/plain` dos emails (spam
// filters penalizam HTML-only). Não é genérico: só cobre os padrões dos
// nossos templates; listas/tabelas/imagens precisam de tratamento adicional.

export function htmlToText(html: string): string {
  let s = html;

  // Remover <style>/<script> COM o conteúdo, senão o CSS/JS leak para o output.
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");

  // <a href="URL">label</a> → "label (URL)" (ou só URL se label == URL).
  // Flag `s` (dotAll) - labels podem ter newlines/tags nested.
  s = s.replace(/<a\b[^>]*?\bhref="([^"]*)"[^>]*?>(.*?)<\/a>/gis, (_, href, label) => {
    const cleanLabel = label.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (!cleanLabel || cleanLabel === href) return href;
    return `${cleanLabel} (${href})`;
  });

  // <br> → newline.
  s = s.replace(/<br\s*\/?>/gi, "\n");

  // Tags de bloco fecham com newline duplo (separa parágrafos no output).
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|article|section)>/gi, "\n\n");

  // Restantes tags removidas (incluindo abertura de bloco e inline tags).
  s = s.replace(/<[^>]+>/g, "");

  // HTML entities - apenas as que `escapeHtml` produz + nbsp comum.
  s = s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  // Ordem importa: trim per-linha ANTES de colapsar newlines, senão a
  // indentação vira "linha vazia" e escapa ao collapse `\n{3,}`.
  s = s.replace(/[ \t]+/g, " ");
  s = s.split("\n").map((l) => l.trim()).join("\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.trim();

  return s;
}
