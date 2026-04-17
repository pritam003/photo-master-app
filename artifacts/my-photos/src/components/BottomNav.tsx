import { Link, useLocation } from "wouter";
import { Images, Heart, BookImage, Users, Plus, Menu } from "lucide-react";
import { useState } from "react";
import Sidebar from "./Sidebar";

interface BottomNavProps {
  onUploadClick: () => void;
  darkMode: boolean;
  onToggleDark: () => void;
}

export default function BottomNav({ onUploadClick, darkMode, onToggleDark }: BottomNavProps) {
  const [location] = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const tabs = [
    { href: "/", icon: Images, label: "Photos" },
    { href: "/favorites", icon: Heart, label: "Favorites" },
    { href: "/albums", icon: BookImage, label: "Albums" },
    { href: "/people", icon: Users, label: "People" },
  ];

  const isActive = (href: string) => href === "/" ? location === "/" : location.startsWith(href);

  return (
    <>
      {/* Slide-in drawer for more options (Archive, Trash, sign-out) */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40" onClick={() => setDrawerOpen(false)}>
          <div className="absolute inset-0 bg-black/50" />
          <div
            className="absolute left-0 top-0 h-full w-64 bg-card border-r border-border shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <Sidebar
              onUploadClick={() => { setDrawerOpen(false); onUploadClick(); }}
              darkMode={darkMode}
              onToggleDark={onToggleDark}
              collapsed={false}
              onCollapse={() => setDrawerOpen(false)}
            />
          </div>
        </div>
      )}

      {/* Bottom navigation bar */}
      <nav
        className="fixed bottom-0 left-0 right-0 z-30 bg-card border-t border-border flex items-stretch"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {tabs.map(({ href, icon: Icon, label }) => {
          const active = isActive(href);
          return (
            <Link key={href} href={href} className="flex-1 flex flex-col items-center justify-center gap-0.5 py-2 min-h-[56px] relative">
              <Icon className={`w-5 h-5 transition-colors ${active ? "text-primary" : "text-muted-foreground"}`} />
              <span className={`text-[10px] font-medium transition-colors ${active ? "text-primary" : "text-muted-foreground"}`}>
                {label}
              </span>
              {active && (
                <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 rounded-full bg-primary" />
              )}
            </Link>
          );
        })}

        {/* Upload FAB */}
        <button
          onClick={onUploadClick}
          className="flex-1 flex flex-col items-center justify-center gap-0.5 py-2 min-h-[56px]"
          aria-label="Upload photos"
        >
          <div className="w-9 h-9 rounded-full bg-primary flex items-center justify-center shadow-lg -mt-3">
            <Plus className="w-5 h-5 text-primary-foreground" />
          </div>
        </button>

        {/* More / drawer trigger */}
        <button
          onClick={() => setDrawerOpen(true)}
          className="flex-1 flex flex-col items-center justify-center gap-0.5 py-2 min-h-[56px]"
          aria-label="More"
        >
          <Menu className="w-5 h-5 text-muted-foreground" />
          <span className="text-[10px] font-medium text-muted-foreground">More</span>
        </button>
      </nav>
    </>
  );
}
