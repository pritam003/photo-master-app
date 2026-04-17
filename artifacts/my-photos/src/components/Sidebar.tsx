import { Link, useLocation } from "wouter";
import { Images, Heart, BookImage, Trash2, LogOut, Sun, Moon, Upload, EyeOff, ChevronLeft, ChevronRight, Users, RefreshCw } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useAuthLogout, useGetPhotoStats } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { formatBytes, API_BASE } from "@/lib/api";
import { useState, useEffect } from "react";


interface SidebarProps {
  onUploadClick: () => void;
  darkMode: boolean;
  onToggleDark: () => void;
  collapsed: boolean;
  onCollapse: (v: boolean) => void;
}

export default function Sidebar({ onUploadClick, darkMode, onToggleDark, collapsed, onCollapse }: SidebarProps) {
  const [location] = useLocation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [restartCountdown, setRestartCountdown] = useState<number | null>(null);

  // Count down from 10 after restart is triggered, then hard-reload
  useEffect(() => {
    if (restartCountdown === null) return;
    if (restartCountdown <= 0) { window.location.reload(); return; }
    const t = setTimeout(() => setRestartCountdown(c => (c ?? 0) - 1), 1000);
    return () => clearTimeout(t);
  }, [restartCountdown]);

  const handleRestart = async () => {
    if (restartCountdown !== null) return;
    try {
      await fetch(`${API_BASE}/admin/restart`, { method: "POST", credentials: "include" });
    } catch { /* server restarting — expected */ }
    setRestartCountdown(10);
  };
  const logout = useAuthLogout();
  const { data: stats, isLoading: statsLoading } = useGetPhotoStats({
    query: { staleTime: 10 * 60 * 1000 },
  });

  const handleLogout = async () => {
    await logout.mutateAsync();
    queryClient.clear();
    window.location.href = "/login";
  };

  const navItems = [
    { href: "/", icon: Images, label: "Photos", count: stats?.total },
    { href: "/favorites", icon: Heart, label: "Favorites", count: stats?.favorites },
    { href: "/albums", icon: BookImage, label: "Albums", count: stats?.albums },
    { href: "/people", icon: Users, label: "People", count: undefined },
    { href: "/archive", icon: EyeOff, label: "Archive", count: (stats as any)?.hidden },
    { href: "/trash", icon: Trash2, label: "Trash", count: stats?.trashed },
  ];

  return (
    <div
      className={`fixed left-0 top-0 h-full w-64 flex flex-col border-r border-sidebar-border z-20 overflow-hidden transition-transform duration-200 will-change-transform ${
        collapsed ? "-translate-x-[204px]" : "translate-x-0"
      }`}
      style={{ background: "var(--sidebar, hsl(var(--card)))" }}
    >
      {/* Header / toggle */}
      <button
        onClick={() => onCollapse(!collapsed)}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        className="flex items-center gap-2.5 p-4 border-b border-sidebar-border hover:bg-sidebar-accent/40 transition-colors w-full text-left"
      >
        <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center shrink-0 shadow-sm">
          <Images className="w-4 h-4 text-primary" />
        </div>
        {!collapsed && (
          <>
            <span className="text-base font-semibold text-sidebar-foreground flex-1 truncate">APhoto</span>
            <ChevronLeft className="w-4 h-4 text-muted-foreground shrink-0" />
          </>
        )}
        {collapsed && <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 ml-auto" />}
      </button>

      {/* Upload button */}
      <div className="p-2">
        {collapsed ? (
          <button
            onClick={onUploadClick}
            data-testid="button-upload"
            title="Upload Photos"
            className="w-full flex items-center justify-center p-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
          >
            <Upload className="w-4 h-4" />
          </button>
        ) : (
          <button
            onClick={onUploadClick}
            data-testid="button-upload"
            className="w-full flex items-center gap-2.5 px-3 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            <Upload className="w-4 h-4" />
            Upload Photos
          </button>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-1 space-y-0.5 overflow-y-auto overflow-x-hidden">
        {navItems.map(({ href, icon: Icon, label, count }) => {
          const isActive = href === "/" ? location === "/" || location === "" : location.startsWith(href);
          return (
            <Link key={href} href={href}>
              <a
                data-testid={`nav-${label.toLowerCase()}`}
                title={collapsed ? label : undefined}
                className={`relative flex items-center gap-2.5 px-2 py-2.5 rounded-xl text-sm font-medium transition-all group ${
                  collapsed ? "justify-center" : "justify-between"
                } ${
                  isActive
                    ? "bg-primary/10 text-primary shadow-sm"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
                }`}
              >
                {isActive && !collapsed && (
                  <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-primary" />
                )}
                <div className={`flex items-center gap-2.5 ${collapsed ? "" : ""}`}>
                  <Icon className={`w-4 h-4 shrink-0 transition-colors ${
                    isActive ? "text-primary" : "text-sidebar-foreground/60 group-hover:text-primary/70"
                  }`} />
                  {!collapsed && label}
                </div>
                {!collapsed && (
                  <span className={`text-xs tabular-nums min-w-[1.5rem] text-right font-medium ${
                    isActive ? "text-primary/70" : "text-muted-foreground"
                  }`}>
                    {statsLoading
                      ? <span className="inline-block w-5 h-2.5 bg-muted-foreground/15 animate-pulse rounded" />
                      : count !== undefined && count > 0 ? count : null}
                  </span>
                )}
                {collapsed && count !== undefined && count > 0 && (
                  <span className="absolute -top-1 -right-1 hidden" />
                )}
              </a>
            </Link>
          );
        })}
      </nav>

      {/* Storage */}
      {!collapsed && stats && stats.totalSize > 0 && (
        <div className="px-5 py-3 border-t border-sidebar-border">
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-xs text-muted-foreground">{formatBytes(stats.totalSize)} used</p>
            <p className="text-xs text-muted-foreground/60">of ∞</p>
          </div>
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div className="h-full rounded-full bg-gradient-to-r from-primary/70 to-primary/40 w-1/4" />
          </div>
        </div>
      )}

      {/* Footer */}
      <div className={`p-2 border-t border-sidebar-border space-y-1`}>
        <button
          onClick={onToggleDark}
          data-testid="button-toggle-theme"
          title={darkMode ? "Light mode" : "Dark mode"}
          className={`w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-sm text-sidebar-foreground hover:bg-sidebar-accent/60 transition-colors ${collapsed ? "justify-center" : ""}`}
        >
          {darkMode ? <Sun className="w-4 h-4 shrink-0" /> : <Moon className="w-4 h-4 shrink-0" />}
          {!collapsed && (darkMode ? "Light mode" : "Dark mode")}
        </button>

        <button
          onClick={handleRestart}
          disabled={restartCountdown !== null}
          title={restartCountdown !== null ? `Reloading in ${restartCountdown}s…` : "Restart server + reload app"}
          className={`w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-sm transition-colors ${
            restartCountdown !== null
              ? "text-amber-500 bg-amber-500/10 cursor-not-allowed"
              : "text-sidebar-foreground hover:bg-sidebar-accent/60"
          } ${collapsed ? "justify-center" : ""}`}
        >
          <RefreshCw className={`w-4 h-4 shrink-0 ${restartCountdown !== null ? "animate-spin" : ""}`} />
          {!collapsed && (
            restartCountdown !== null
              ? `Reloading in ${restartCountdown}s…`
              : "Restart & reload"
          )}
        </button>

        {user && (
          <div className={`flex items-center gap-2.5 px-2 py-2 rounded-lg ${collapsed ? "justify-center" : ""}`}>
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center text-primary-foreground text-xs font-bold shrink-0 shadow-sm ring-2 ring-primary/20">
              {user.name?.[0]?.toUpperCase() ?? "U"}
            </div>
            {!collapsed && (
              <>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-sidebar-foreground truncate">{user.name}</p>
                  <p className="text-xs text-muted-foreground truncate">{user.email}</p>
                </div>
                <button
                  onClick={handleLogout}
                  data-testid="button-logout"
                  title="Sign out"
                  className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors shrink-0"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </>
            )}
            {collapsed && (
              <button
                onClick={handleLogout}
                data-testid="button-logout"
                title="Sign out"
                className="hidden"
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
