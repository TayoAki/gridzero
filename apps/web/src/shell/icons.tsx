// Small line icons for the rail. 20px, drawn on a 24 grid.

const P: Record<string, string> = {
  home: "M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z",
  sheets: "M4 5h16v14H4zM4 10h16M4 15h16M9 5v14",
  sql: "M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 5l-3 14",
  search: "M11 4a7 7 0 1 0 4.9 12l4.1 4M11 4a7 7 0 0 1 4.9 12",
  data: "M4 5h16v14H4zM4 10h16M4 15h16M10 5v14",
  reports: "M5 20V10M12 20V4M19 20v-7",
  agents: "M12 3l2.2 5.3L20 9l-4.3 3.9L17 19l-5-3-5 3 1.3-6.1L4 9l5.8-.7z",
  count: "M5 6h14M5 12h9M5 18h6M17 15l2 2 3-4",
  apps: "M5 5h6v6H5zM13 5h6v6h-6zM5 13h6v6H5zM13 13h6v6h-6z",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0",
  settings: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM4 12h2M18 12h2M12 4v2M12 18v2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4",
  account: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0",
  preview: "M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3",
  panel: "M4 5h16v14H4zM14 5v14",
  list: "M4 5h16v14H4zM9 5v14",
  close: "M6 6l12 12M18 6L6 18",
  clients: "M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM16 11a3 3 0 1 0 0-6M2 20a6 6 0 0 1 12 0M14 14a6 6 0 0 1 8 6",
};

export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name] ?? P.home} />
    </svg>
  );
}
