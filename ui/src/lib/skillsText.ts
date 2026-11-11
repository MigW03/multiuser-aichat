import type { SkillItem, SkillsList } from "@mc/shared";
import type { StyledLine } from "./markdownLive.ts";

/** One skill in the "/" list. */
export type MenuSkill = { name: string; description: string; /** Where it comes from, for the small label: "mine", "project", or the plugin's name. */ from: string };

const pluginOf = (name: string) => (name.includes(":") ? name.slice(0, name.indexOf(":")) : null);

/**
 * The skills a chat can use, for the "/" list: the person's own and the project's that are switched on (a plugin's skill also
 * needs its plugin on). The same name in both places is the project's, as on the server. Sorted by name.
 */
export function skillMenu(list: SkillsList | null): MenuSkill[] {
  if (!list) return [];
  const byName = new Map<string, MenuSkill>();
  const add = (skills: SkillItem[], pluginsOff: Set<string>, label: string) => {
    for (const s of skills) {
      if (!s.enabled || (s.plugin_id && pluginsOff.has(s.plugin_id))) continue;
      byName.set(s.name, { name: s.name, description: s.description, from: pluginOf(s.name) ?? label });
    }
  };
  add(list.mine.skills, new Set(list.mine.plugins.filter((p) => !p.enabled).map((p) => p.id)), "mine");
  if (list.project) add(list.project.skills, new Set(list.project.plugins.filter((p) => !p.enabled).map((p) => p.id)), "project");
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The "/" typed at the caret: where it starts and what follows it. Only at the start of the text or after a space. */
export function slashToken(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)\/([a-z0-9:-]*)$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[2]!.length - 1, query: m[2]! } : null;
}

/** Skills whose name starts with the query first, then ones that contain it; at most `max`. */
export function matchSkills(menu: MenuSkill[], query: string, max = 6): MenuSkill[] {
  const q = query.toLowerCase();
  const rank = (s: MenuSkill) => (s.name.startsWith(q) ? 0 : s.name.split(":").at(-1)!.startsWith(q) ? 1 : s.name.includes(q) ? 2 : 3);
  return menu
    .filter((s) => rank(s) < 3)
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .slice(0, max);
}

/**
 * Marks "/name" in the composer's styled text when it is a skill the chat can use, so the person sees it will be used. It
 * only splits plain text pieces and never changes any character, so the caret stays where it is.
 */
export function markSkillTokens(lines: StyledLine[], names: ReadonlySet<string>): StyledLine[] {
  if (names.size === 0) return lines;
  return lines.map((line) => {
    if (line.kind === "fence" || line.kind === "code") return line;
    const spans = line.spans.flatMap((s) => {
      if (s.kind || !s.text.includes("/")) return [s];
      const out: StyledLine["spans"] = [];
      let last = 0;
      for (const m of s.text.matchAll(/(^|[\s([{"'])(\/([a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)?))(?=$|[\s.,;:!?)\]}"'])/g)) {
        if (!names.has(m[3]!)) continue;
        const at = m.index! + m[1]!.length;
        if (at > last) out.push({ text: s.text.slice(last, at) });
        out.push({ text: m[2]!, kind: "skill" });
        last = at + m[2]!.length;
      }
      if (last === 0) return [s];
      if (last < s.text.length) out.push({ text: s.text.slice(last) });
      return out;
    });
    return { ...line, spans };
  });
}
