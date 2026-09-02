/**
 * 本文を <text> などの区切りタグに入れる前に、区切りと同じタグを無害化する。
 * 本文に </text> が含まれると区切りが閉じ、残りがモデルへの指示として読まれてしまう
 * （XML の例やプロンプトインジェクション）。判定プロンプトと rewrite テンプレートの両方で使う
 */
export function escapeDelimiters(text: string): string {
  return text.replace(/<(\/?)(text(?:_a|_b)?)(\s*)>/gi, "&lt;$1$2$3&gt;");
}
