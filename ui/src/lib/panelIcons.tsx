import type { PanelIcon } from "@mc/shared";
import { Calendar, ChartColumn, Code, Globe, LayoutPanelTop, ListChecks, StickyNote, Star, Table, Zap, type LucideIcon } from "lucide-react";

/** How each icon a panel can wear is drawn. */
export const PANEL_ICON_VIEWS: Record<PanelIcon, LucideIcon> = {
  panel: LayoutPanelTop,
  list: ListChecks,
  chart: ChartColumn,
  table: Table,
  note: StickyNote,
  calendar: Calendar,
  star: Star,
  bolt: Zap,
  globe: Globe,
  code: Code,
};
