import { Switch, Route, Router as WouterRouter, useLocation, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import Sidebar from "@/components/Sidebar";
import BottomNav from "@/components/BottomNav";
import UploadModal from "@/components/UploadModal";
import { getSharedFiles, clearSharedFiles } from "@/lib/shared-files-db";
import LibraryPage from "@/pages/library";
import FavoritesPage from "@/pages/favorites";
import AlbumsPage from "@/pages/albums";
import AlbumDetailPage from "@/pages/album-detail";
import TrashPage from "@/pages/trash";
import ArchivePage from "@/pages/archive";

import LoginPage from "@/pages/login";
import SharePage from "@/pages/share";
import SharedAlbumPage from "@/pages/shared-album";
import NotFound from "@/pages/not-found";
import { useAuth } from "@/hooks/useAuth";
import { useIsMobile } from "@/hooks/use-mobile";
import { ImportProvider } from "@/lib/importContext";
import ImportProgressBanner from "@/components/ImportProgressBanner";
import GoogleImportModal from "@/components/GoogleImportModal";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2 * 60 * 1000,
      retry: (count, err: any) => {
        if (err?.status === 401 || err?.response?.status === 401) return false;
        return count < 2;
      },
    },
  },
});

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const [location] = useLocation();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Redirect to="/login" />;
  }

  return <>{children}</>;
}

function AppLayout() {
  const [showUpload, setShowUpload] = useState(false);
  const [initialUploadFiles, setInitialUploadFiles] = useState<File[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [showGoogleImport, setShowGoogleImport] = useState(false);
  const isMobile = useIsMobile();

  // Handle photos shared from the device gallery via the Web Share Target API.
  // The service worker intercepts POST /share-target, saves files to IndexedDB,
  // then redirects here with ?shared=1.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("shared")) return;
    // Remove query param immediately so a refresh doesn't re-trigger
    const url = new URL(window.location.href);
    url.searchParams.delete("shared");
    window.history.replaceState(null, "", url.toString());

    getSharedFiles()
      .then((entries) => {
        if (entries.length === 0) return;
        const files = entries.map(
          (e) => new File([e.data], e.name, { type: e.type, lastModified: e.lastModified })
        );
        clearSharedFiles().catch(() => {});
        setInitialUploadFiles(files);
        setShowUpload(true);
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [darkMode, setDarkMode] = useState(() => {
    return document.documentElement.classList.contains("dark") ||
      window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
  }, [darkMode]);

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-background">
      {!isMobile && (
        <Sidebar
          onUploadClick={() => setShowUpload(true)}
          darkMode={darkMode}
          onToggleDark={() => setDarkMode(d => !d)}
          collapsed={collapsed}
          onCollapse={setCollapsed}
        />
      )}
      <main
        className={`flex-1 flex flex-col overflow-hidden ${
          isMobile ? "ml-0 pb-[calc(56px+env(safe-area-inset-bottom))]" : collapsed ? "ml-[52px]" : "ml-64"
        }`}
      >
        <Switch>
          <Route path="/" component={LibraryPage} />
          <Route path="/favorites" component={FavoritesPage} />
          <Route path="/albums" component={AlbumsPage} />
          <Route path="/albums/:id" component={AlbumDetailPage} />
          <Route path="/trash" component={TrashPage} />
          <Route path="/archive" component={ArchivePage} />
          <Route component={NotFound} />
        </Switch>
      </main>
      {isMobile && (
        <BottomNav
          onUploadClick={() => setShowUpload(true)}
          darkMode={darkMode}
          onToggleDark={() => setDarkMode(d => !d)}
        />
      )}
      {showUpload && (
        <UploadModal
          onClose={() => {
            setShowUpload(false);
            setInitialUploadFiles([]);
          }}
          initialFiles={initialUploadFiles}
        />
      )}
      <ImportProgressBanner onImportMore={() => setShowGoogleImport(true)} />
      {showGoogleImport && (
        <GoogleImportModal
          onClose={() => setShowGoogleImport(false)}
          allowCreateAlbum
        />
      )}
    </div>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={LoginPage} />
      <Route path="/share/:token" component={SharePage} />
      <Route path="/shared/album/:token" component={SharedAlbumPage} />
      <Route>
        <AuthGuard>
          <AppLayout />
        </AuthGuard>
      </Route>
    </Switch>
  );
}

function App() {
  // Show a toast when a new service worker version is waiting to activate
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  useEffect(() => {
    if (needRefresh) {
      toast("Update available", {
        description: "A new version of APhoto is ready.",
        action: {
          label: "Reload",
          onClick: () => updateServiceWorker(true),
        },
        duration: Infinity,
      });
    }
  }, [needRefresh, updateServiceWorker]);

  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <ImportProvider>
          <Router />
          <Toaster />
        </ImportProvider>
      </WouterRouter>
    </QueryClientProvider>
  );
}

export default App;
