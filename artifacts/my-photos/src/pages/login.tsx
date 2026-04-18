import { useEffect, useState, useRef } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/useAuth";
import { API_BASE } from "@/lib/api";

/* ── Keyframes ──────────────────────────────────────────────────────────── */
const ANIM_CSS = `
  @keyframes bubble-rise {
    0%   { opacity: 0;    transform: translateY(0) scale(0.08); }
    6%   { opacity: 1;    transform: translateY(calc(var(--ey) * 0.05)) scale(0.32); }
    50%  { opacity: 0.88; transform: translateY(calc(var(--ey) * 0.5))  scale(0.85); }
    80%  { opacity: 0.72; transform: translateY(calc(var(--ey) * 0.8))  scale(1.45); }
    91%  { opacity: 0.38; transform: translateY(calc(var(--ey) * 0.94)) scale(2.2); }
    97%  { opacity: 0.08; transform: translateY(calc(var(--ey) * 0.99)) scale(2.9); }
    100% { opacity: 0;    transform: translateY(var(--ey)) scale(3.1); }
  }
  @keyframes bubble-drift {
    0%   { transform: translateX(0); }
    28%  { transform: translateX(calc(var(--sx) * 0.45)); }
    55%  { transform: translateX(var(--sx)); }
    78%  { transform: translateX(calc(var(--sx) * 0.3)); }
    100% { transform: translateX(0); }
  }
  @keyframes card-enter {
    from { opacity:0; transform:translateY(40px) scale(0.93); }
    to   { opacity:1; transform:translateY(0)   scale(1); }
  }
  @keyframes fade-up {
    from { opacity:0; transform:translateY(12px); }
    to   { opacity:1; transform:translateY(0); }
  }
  @keyframes glow-pulse {
    0%,100% { opacity:0.55; transform:scale(1); }
    50%     { opacity:0.9;  transform:scale(1.08); }
  }
  @keyframes shimmer {
    0%   { background-position:-400% center; }
    100% { background-position:400% center; }
  }
  @keyframes spin {
    to { transform:rotate(360deg); }
  }
  @keyframes shutter {
    0%   { transform: scale(1)    rotate(0deg);   filter:drop-shadow(0 8px 24px rgba(139,92,246,0.5)); }
    15%  { transform: scale(0.78) rotate(-8deg);  filter:drop-shadow(0 2px 6px  rgba(139,92,246,0.3)) brightness(0.7); }
    30%  { transform: scale(1.22) rotate(6deg);   filter:drop-shadow(0 12px 32px rgba(255,220,50,0.8)) brightness(1.4); }
    50%  { transform: scale(1.05) rotate(-3deg);  filter:drop-shadow(0 8px 24px rgba(139,92,246,0.6)); }
    70%  { transform: scale(1.0)  rotate(2deg); }
    100% { transform: scale(1)    rotate(0deg);   filter:drop-shadow(0 8px 24px rgba(139,92,246,0.5)); }
  }
  @keyframes flash-in {
    0%   { opacity:0; transform:translateY(6px) scale(0.8); }
    30%  { opacity:1; transform:translateY(-4px) scale(1.12); }
    70%  { opacity:1; transform:translateY(0)   scale(1); }
    100% { opacity:0; transform:translateY(-8px) scale(0.9); }
  }
  @keyframes quote-fade {
    0%   { opacity:0; transform:translateY(6px); }
    20%  { opacity:1; transform:translateY(0); }
    100% { opacity:1; transform:translateY(0); }
  }
  @keyframes camera-idle {
    0%   { transform: scale(1)    rotate(0deg); }
    10%  { transform: scale(1.35) rotate(-4deg); }
    22%  { transform: scale(0.82) rotate(5deg); }
    34%  { transform: scale(1.12) rotate(-2deg); }
    46%  { transform: scale(1.0)  rotate(0deg); }
    100% { transform: scale(1)    rotate(0deg); }
  }
`;

const QUOTES = [
  { text: "Life is a collection of moments. Make them beautiful.", author: "— Unknown" },
  { text: "One day or day one. You decide.", author: "— Paulo Coelho" },
  { text: "Happiness is not something ready-made. It comes from your own actions.", author: "— Dalai Lama" },
  { text: "The best thing to hold onto in life is each other.", author: "— Audrey Hepburn" },
  { text: "In every smile there is a memory worth keeping.", author: "— Unknown" },
  { text: "Photography is the story I fail to put into words.", author: "— Destin Sparks" },
  { text: "A photograph is a pause button on life.", author: "— Ty Holland" },
];

const REGIONS = [
  { label: "🇺🇸 East US",               value: "eastus" },
  { label: "🇺🇸 West US 2",             value: "westus2" },
  { label: "🇺🇸 Central US",            value: "centralus" },
  { label: "🇬🇧 UK South",              value: "uksouth" },
  { label: "🇩🇪 West Europe",           value: "westeurope" },
  { label: "🇩🇪 Germany West Central",  value: "germanywestcentral" },
  { label: "🇦🇺 Australia East",        value: "australiaeast" },
  { label: "🇸🇬 Southeast Asia",        value: "southeastasia" },
  { label: "🇮🇳 Central India",         value: "centralindia" },
  { label: "🇧🇷 Brazil South",          value: "brazilsouth" },
];

const TEMPLATE_URL =
  "https://raw.githubusercontent.com/pritam003/photo-master-app/main/infra/azuredeploy.json";

export default function LoginPage() {
  const { isAuthenticated, isLoading } = useAuth();
  const [, navigate] = useLocation();

  const [msLoading, setMsLoading] = useState(false);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [verificationUri, setVerificationUri] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Camera animation
  const [cameraClicked, setCameraClicked] = useState(false);
  const [showSmile, setShowSmile] = useState(false);
  const [smileText, setSmileText] = useState("Say Cheese! 🧀");
  const smileTexts = ["Say Cheese! 🧀", "Smile! 😄", "Click! 📸", "Perfect! ✨", "Beautiful! 🌟"];
  const smileIdx = useRef(0);
  const [quoteIdx, setQuoteIdx] = useState(() => Math.floor(Math.random() * QUOTES.length));

  // Auto-fire camera click every 3.5s
  useEffect(() => {
    const fire = () => {
      smileIdx.current = (smileIdx.current + 1) % smileTexts.length;
      setSmileText(smileTexts[smileIdx.current]);
      setCameraClicked(true);
      setShowSmile(true);
      setTimeout(() => setShowSmile(false), 1400);
      setTimeout(() => setCameraClicked(false), 700);
    };
    const t = setInterval(fire, 3500);
    // Fire once on mount after a short delay
    const init = setTimeout(fire, 800);
    return () => { clearInterval(t); clearTimeout(init); };
  }, []);

  const [error, setError] = useState<string | null>(() => {
    const p = new URLSearchParams(window.location.search);
    return p.get("error");
  });

  // Deploy-to-Azure modal
  const [showDeployModal, setShowDeployModal] = useState(false);
  const [deployAppName, setDeployAppName] = useState("myphotos");
  const [deployRegion, setDeployRegion] = useState("eastus");

  useEffect(() => {
    if (!isLoading && isAuthenticated) navigate("/");
  }, [isAuthenticated, isLoading, navigate]);

  // Poll Microsoft device code
  useEffect(() => {
    if (!deviceCode) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/auth/device-code-status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_code: deviceCode }),
          credentials: "include",
        });
        const data = await res.json() as { status?: string };
        if (res.ok && data.status === "success") {
          clearInterval(interval);
          navigate("/");
        } else if (res.status === 410) {
          clearInterval(interval);
          setDeviceCode(null); setUserCode(null); setVerificationUri(null);
          setError("Code expired. Please try again.");
        }
      } catch { /* keep polling */ }
    }, 2000);
    return () => clearInterval(interval);
  }, [deviceCode, navigate]);

  // Rotate quote every 6s
  useEffect(() => {
    const t = setInterval(() => setQuoteIdx(i => (i + 1) % QUOTES.length), 6000);
    return () => clearInterval(t);
  }, []);

  const handleMicrosoftLogin = async () => {
    setMsLoading(true); setError(null);
    try {
      const res = await fetch(`${API_BASE}/auth/login`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to start login");
      const data = await res.json() as { device_code: string; user_code: string; verification_uri: string };
      setDeviceCode(data.device_code);
      setUserCode(data.user_code);
      setVerificationUri(data.verification_uri);
    } catch (e) {
      setError(`Login failed: ${String(e)}`);
    } finally {
      setMsLoading(false);
    }
  };

  const handleCopy = () => {
    if (userCode) {
      navigator.clipboard.writeText(userCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  /* ── Shared animated background ─────────────────────────────────────── */
  const Bg = () => (
    <>
      <style>{ANIM_CSS}</style>
      {/* Light pastel base — lavender → sky → blush */}
      <div className="absolute inset-0"
        style={{ background: "linear-gradient(145deg,#ede9fe 0%,#e0f2fe 40%,#fce7f3 70%,#f0fdf4 100%)" }} />
    </>
  );

  /* ── Device-code step ────────────────────────────────────────────────── */
  if (deviceCode && userCode && verificationUri) {
    return (
      <div className="relative min-h-screen flex items-center justify-center p-4 overflow-hidden">
        <Bg />
        <div className="relative z-10 w-full max-w-sm"
          style={{ animation:"card-enter 0.6s cubic-bezier(0.16,1,0.3,1) both" }}>
          <div style={{
            background:"rgba(255,255,255,0.82)",
            backdropFilter:"blur(28px)",
            WebkitBackdropFilter:"blur(28px)",
            border:"1px solid rgba(139,92,246,0.15)",
            borderRadius:28,
            padding:"2.5rem",
            boxShadow:"0 24px 64px rgba(139,92,246,0.15), 0 4px 16px rgba(0,0,0,0.06)"
          }}>
            {/* Logo */}
            <div className="flex flex-col items-center gap-2 mb-7">
              <div className="text-5xl" style={{ animation:"soft-float 3s ease-in-out infinite" }}>📸</div>
              <h2 className="text-xl font-bold text-slate-800 tracking-tight">One more step</h2>
              <p className="text-sm text-slate-500">Complete sign-in in your browser</p>
            </div>

            {/* Step 1 */}
            <div className="mb-4" style={{ animation:"fade-up 0.5s 0.1s both" }}>
              <p className="text-[10px] font-bold text-violet-600 uppercase tracking-widest mb-2">Step 1 — Copy your code</p>
              <div onClick={handleCopy} className="group cursor-pointer flex flex-col items-center gap-2 rounded-2xl px-5 py-4 transition-all active:scale-95"
                style={{ background:"rgba(139,92,246,0.06)", border:"1px solid rgba(139,92,246,0.15)" }}>
                <span className="font-mono text-2xl font-bold text-slate-800 tracking-[0.25em] w-full text-center">{userCode}</span>
                <span className="flex items-center gap-1.5 text-xs text-slate-400 group-hover:text-violet-600 transition-colors">
                  <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                  </svg>
                  {copied ? "✓ Copied!" : "Tap to copy"}
                </span>
              </div>
            </div>

            {/* Step 2 */}
            <div className="mb-5" style={{ animation:"fade-up 0.5s 0.2s both" }}>
              <p className="text-[10px] font-bold text-violet-600 uppercase tracking-widest mb-2">Step 2 — Open link</p>
              <a href={verificationUri} target="_blank" rel="noopener noreferrer"
                className="flex items-center justify-center gap-3 w-full py-3.5 rounded-2xl text-white text-sm font-semibold transition-all hover:-translate-y-0.5"
                style={{ background:"linear-gradient(135deg,#0078D4,#1a56db)", boxShadow:"0 8px 24px rgba(0,120,212,0.35)" }}>
                <svg viewBox="0 0 23 23" className="w-4 h-4 shrink-0" fill="none">
                  <path fill="#f35325" d="M1 1h10v10H1z"/>
                  <path fill="#81bc06" d="M12 1h10v10H12z"/>
                  <path fill="#05a6f0" d="M1 12h10v10H1z"/>
                  <path fill="#ffba08" d="M12 12h10v10H12z"/>
                </svg>
                Open Microsoft Login →
              </a>
            </div>

            <div className="flex items-center gap-2 text-xs text-slate-400 mb-5" style={{ animation:"fade-up 0.5s 0.3s both" }}>
              <span className="w-1.5 h-1.5 rounded-full bg-violet-500 inline-block animate-pulse" />
              Waiting for you to sign in…
            </div>

            <button onClick={() => { setDeviceCode(null); setUserCode(null); setVerificationUri(null); }}
              className="w-full py-2.5 rounded-2xl text-sm text-slate-400 hover:text-slate-600 transition-colors"
              style={{ border:"1px solid rgba(139,92,246,0.15)" }}>
              ← Start over
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* ── Main login ──────────────────────────────────────────────────────── */
  return (
    <div className="relative min-h-screen flex items-center justify-center p-4 overflow-hidden">
      <Bg />

      <div className="relative z-10 w-full max-w-[420px]"
        style={{ animation:"card-enter 0.65s cubic-bezier(0.16,1,0.3,1) both" }}>
        <div style={{
          background:"rgba(255,255,255,0.85)",
          backdropFilter:"blur(32px)",
          WebkitBackdropFilter:"blur(32px)",
          border:"1px solid rgba(139,92,246,0.18)",
          borderRadius:32,
          padding:"2.75rem",
          boxShadow:"0 32px 72px rgba(139,92,246,0.18), 0 4px 20px rgba(0,0,0,0.06)"
        }}>

          {/* Hero emoji + title */}
          <div className="flex flex-col items-center gap-3 mb-8">
            {/* Auto-animated camera */}
            <div className="relative flex items-center justify-center select-none">
              <div className="absolute w-24 h-24 rounded-full"
                style={{ background:"radial-gradient(circle,rgba(139,92,246,0.35),transparent 70%)",
                  animation:"glow-pulse 2.8s ease-in-out infinite" }} />
              <span className="relative text-[64px] leading-none"
                style={{
                  animation: cameraClicked
                    ? "shutter 0.65s cubic-bezier(0.36,0.07,0.19,0.97) forwards"
                    : "camera-idle 3.5s ease-in-out infinite",
                  filter:"drop-shadow(0 8px 24px rgba(139,92,246,0.5))",
                  display:"inline-block",
                }}>
                📷
              </span>
              {/* Flash overlay */}
              {cameraClicked && (
                <div className="absolute inset-0 rounded-full pointer-events-none"
                  style={{ background:"rgba(255,255,255,0.7)", animation:"shutter 0.3s ease-out both" }} />
              )}
              {/* "Say Cheese!" pop */}
              {showSmile && (
                <div className="absolute -top-10 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full text-sm font-bold text-white whitespace-nowrap pointer-events-none"
                  style={{
                    background:"linear-gradient(135deg,#a855f7,#ec4899)",
                    boxShadow:"0 4px 16px rgba(168,85,247,0.5)",
                    animation:"flash-in 1.4s ease-out both",
                  }}>
                  {smileText}
                </div>
              )}
            </div>

            <h1 className="text-[2rem] font-black text-slate-800 tracking-tight leading-none mt-3"
              style={{ animation:"fade-up 0.5s 0.05s both" }}>
              APhoto
            </h1>
            <p className="text-sm text-slate-500 text-center leading-relaxed"
              style={{ animation:"fade-up 0.5s 0.12s both" }}>
              Your memories, beautifully organized
            </p>

            {/* Rotating happiness quote */}
            <div className="mt-2 px-4 py-3 rounded-2xl text-center max-w-xs"
              style={{ background:"rgba(139,92,246,0.06)", border:"1px solid rgba(139,92,246,0.12)" }}>
              <p key={quoteIdx} className="text-xs text-slate-600 italic leading-relaxed"
                style={{ animation:"quote-fade 0.8s ease-out forwards" }}>
                "{QUOTES[quoteIdx].text}"
              </p>
              <p className="text-[10px] text-violet-400 font-medium mt-1">{QUOTES[quoteIdx].author}</p>
            </div>
          </div>

          {/* Feature row */}
          <div className="flex items-center justify-center gap-2 flex-wrap mb-7"
            style={{ animation:"fade-up 0.5s 0.18s both" }}>
            {[["📸","Photos"],["🖼️","Albums"],["❤️","Favorites"],["☁️","Backup"]].map(([icon, label]) => (
              <div key={label} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-slate-600 font-medium"
                style={{ background:"rgba(139,92,246,0.07)", border:"1px solid rgba(139,92,246,0.14)" }}>
                <span>{icon}</span>{label}
              </div>
            ))}
          </div>

          {/* Divider */}
          <div className="h-px mb-7" style={{ background:"rgba(139,92,246,0.12)", animation:"fade-up 0.5s 0.22s both" }} />

          {/* Error */}
          {error && (
            <div className="mb-4 px-4 py-3 rounded-2xl text-sm text-rose-600"
              style={{ background:"rgba(244,63,94,0.08)", border:"1px solid rgba(244,63,94,0.2)" }}>
              {error === "cancelled" ? "Sign-in was cancelled." :
               error === "expired"   ? "Session expired. Please try again." :
               error === "auth_failed" ? "Authentication failed. Please try again." :
               `Error: ${error}`}
            </div>
          )}

          {/* CTA */}
          <div style={{ animation:"fade-up 0.5s 0.28s both" }}>
            <button
              onClick={handleMicrosoftLogin}
              disabled={msLoading}
              data-testid="button-microsoft-login"
              className="group relative w-full overflow-hidden flex items-center gap-4 px-6 py-4 rounded-2xl text-white font-semibold transition-all duration-300 hover:-translate-y-1 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                background:"linear-gradient(135deg,#7c3aed 0%,#6d28d9 50%,#4f46e5 100%)",
                boxShadow:"0 12px 40px rgba(124,58,237,0.45)",
              }}>
              {/* shimmer sweep */}
              <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"
                style={{ background:"linear-gradient(105deg,transparent 30%,rgba(255,255,255,0.12) 50%,transparent 70%)",
                  backgroundSize:"400% 100%", animation:"shimmer 1.8s ease infinite" }} />

              {msLoading
                ? <div className="w-5 h-5 border-2 border-white/25 border-t-white rounded-full shrink-0"
                    style={{ animation:"spin 0.7s linear infinite" }} />
                : <svg viewBox="0 0 23 23" className="w-5 h-5 shrink-0" fill="none">
                    <path fill="#f35325" d="M1 1h10v10H1z"/>
                    <path fill="#81bc06" d="M12 1h10v10H12z"/>
                    <path fill="#05a6f0" d="M1 12h10v10H1z"/>
                    <path fill="#ffba08" d="M12 12h10v10H12z"/>
                  </svg>
              }
              <div className="text-left flex-1">
                <p className="text-sm font-bold">{msLoading ? "Preparing sign-in…" : "Continue with Microsoft"}</p>
                <p className="text-xs text-white/55 font-normal mt-0.5">Personal or work account</p>
              </div>
              <svg viewBox="0 0 24 24" className="w-4 h-4 text-white/50 group-hover:text-white group-hover:translate-x-1 transition-all duration-200 shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M9 18l6-6-6-6"/>
              </svg>
            </button>
          </div>

          {/* ── Deploy to Azure ─────────────────────────────────── */}
          <div className="mt-3" style={{ animation:"fade-up 0.5s 0.32s both" }}>
            <div className="flex items-center gap-2 my-3">
              <div className="flex-1 h-px" style={{ background:"rgba(139,92,246,0.12)" }} />
              <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">or</span>
              <div className="flex-1 h-px" style={{ background:"rgba(139,92,246,0.12)" }} />
            </div>
            <button
              onClick={() => setShowDeployModal(true)}
              data-testid="button-deploy-azure"
              className="group w-full flex items-center gap-3 px-5 py-3.5 rounded-2xl font-semibold transition-all duration-300 hover:-translate-y-0.5"
              style={{
                background:"linear-gradient(135deg,#0078d4 0%,#005a9e 100%)",
                boxShadow:"0 8px 28px rgba(0,120,212,0.35)",
                color:"#fff",
              }}>
              <svg viewBox="0 0 24 24" className="w-5 h-5 shrink-0" fill="currentColor">
                <path d="M13.05 4.24L7.4 16.72l1.94.01 1.18-2.83h5.37l1.2 2.82 1.91-.01-5.62-12.47zm-.03 3.49l1.9 4.5h-3.75l1.85-4.5zM4 6.38A9.98 9.98 0 0 0 2 12c0 5.52 4.48 10 10 10s10-4.48 10-10S17.52 2 12 2a9.98 9.98 0 0 0-7.18 3.06L6.3 6.54A7.958 7.958 0 0 1 12 4c4.42 0 8 3.58 8 8s-3.58 8-8 8-8-3.58-8-8c0-1.8.6-3.46 1.6-4.8L4 6.38z"/>
              </svg>
              <div className="text-left flex-1">
                <p className="text-sm font-bold">Deploy to Azure</p>
                <p className="text-xs opacity-70 font-normal mt-0.5">One-click self-host setup</p>
              </div>
              <svg viewBox="0 0 24 24" className="w-4 h-4 opacity-60 group-hover:opacity-100 group-hover:translate-x-1 transition-all duration-200 shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M9 18l6-6-6-6"/>
              </svg>
            </button>
          </div>

          <p className="text-[11px] text-center text-slate-400 mt-6"
            style={{ animation:"fade-up 0.5s 0.38s both" }}>
            By signing in you agree to our{" "}
            <span className="text-slate-500 underline underline-offset-2 cursor-pointer hover:text-slate-800 transition-colors">Terms</span>
            {" "}and{" "}
            <span className="text-slate-500 underline underline-offset-2 cursor-pointer hover:text-slate-800 transition-colors">Privacy Policy</span>
          </p>
        </div>
      </div>

      {/* ── Deploy-to-Azure Modal ────────────────────────────────────── */}
      {showDeployModal && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center p-4"
          style={{ background:"rgba(15,10,30,0.65)", backdropFilter:"blur(8px)", WebkitBackdropFilter:"blur(8px)" }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowDeployModal(false); }}
        >
          <div
            className="w-full max-w-md overflow-y-auto"
            style={{
              maxHeight:"90vh",
              background:"rgba(255,255,255,0.96)",
              backdropFilter:"blur(24px)",
              borderRadius:24,
              padding:"1.75rem",
              boxShadow:"0 32px 80px rgba(0,0,0,0.22)",
              animation:"card-enter 0.35s cubic-bezier(0.16,1,0.3,1) both",
            }}
          >
            {/* Header */}
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl flex items-center justify-center"
                  style={{ background:"linear-gradient(135deg,#0078d4,#005a9e)" }}>
                  <svg viewBox="0 0 24 24" className="w-4 h-4 text-white" fill="currentColor">
                    <path d="M13.05 4.24L7.4 16.72l1.94.01 1.18-2.83h5.37l1.2 2.82 1.91-.01-5.62-12.47zm-.03 3.49l1.9 4.5h-3.75l1.85-4.5z"/>
                  </svg>
                </div>
                <h2 className="text-base font-bold text-slate-800">Deploy APhoto to Azure</h2>
              </div>
              <button
                onClick={() => setShowDeployModal(false)}
                className="w-7 h-7 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
              >
                <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
              </button>
            </div>

            {/* App name */}
            <div className="mb-4">
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">App name</label>
              <input
                type="text"
                value={deployAppName}
                onChange={(e) => setDeployAppName(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16))}
                placeholder="myphotos"
                className="w-full px-3.5 py-2.5 rounded-xl text-sm text-slate-800 font-mono outline-none transition-all"
                style={{
                  border:"1.5px solid rgba(139,92,246,0.25)",
                  background:"rgba(139,92,246,0.03)",
                }}
                onFocus={(e) => { e.currentTarget.style.borderColor = "rgba(0,120,212,0.6)"; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = "rgba(139,92,246,0.25)"; }}
              />
              <p className="text-[10px] text-slate-400 mt-1">Lowercase letters &amp; numbers, 3–16 chars — drives all resource names.</p>
            </div>

            {/* Region */}
            <div className="mb-5">
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">Azure region</label>
              <select
                value={deployRegion}
                onChange={(e) => setDeployRegion(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl text-sm text-slate-800 outline-none transition-all appearance-none"
                style={{
                  border:"1.5px solid rgba(139,92,246,0.25)",
                  background:"rgba(139,92,246,0.03)",
                  backgroundImage:`url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
                  backgroundRepeat:"no-repeat",
                  backgroundPosition:"right 12px center",
                  backgroundSize:"16px",
                  paddingRight:"2.5rem",
                }}
                onFocus={(e) => { e.currentTarget.style.borderColor = "rgba(0,120,212,0.6)"; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = "rgba(139,92,246,0.25)"; }}
              >
                {REGIONS.map(r => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>

            {/* Resources that will be created */}
            <div className="mb-5">
              <p className="text-xs font-semibold text-slate-600 mb-2">Resources that will be created in <span className="text-violet-600">{deployAppName || "myphotos"}-rg</span></p>
              <div className="rounded-xl overflow-hidden" style={{ border:"1px solid rgba(139,92,246,0.12)" }}>
                {([
                  ["🗄️", "PostgreSQL Flexible Server", `${deployAppName || "myphotos"}-db`, "~$13/mo"],
                  ["📦", "Container Registry (Basic)", `${(deployAppName || "myphotos").replace(/-/g,"")}acr`, "~$5/mo"],
                  ["☁️", "Storage Account", `${(deployAppName || "myphotos").replace(/-/g,"")}store`.slice(0,24), "Free tier"],
                  ["🚀", "Container App — API", `${deployAppName || "myphotos"}-api`, "Pay-per-use"],
                  ["⚙️", "Container App — Worker", `${deployAppName || "myphotos"}-worker`, "Pay-per-use"],
                  ["🌐", "Static Web App", `${deployAppName || "myphotos"}-web`, "Free"],
                  ["👁️", "Computer Vision", `${deployAppName || "myphotos"}-vision`, "Free tier"],
                  ["🔑", "Managed Identity", `${deployAppName || "myphotos"}-id`, "Free"],
                ] as [string,string,string,string][]).map(([icon, type, name, cost], i) => (
                  <div key={name} className="flex items-center gap-2.5 px-3 py-2 text-xs" style={{
                    borderTop: i === 0 ? "none" : "1px solid rgba(139,92,246,0.07)",
                    background: i % 2 === 0 ? "rgba(249,250,251,0.8)" : "#fff",
                  }}>
                    <span className="text-base leading-none">{icon}</span>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-slate-700 truncate">{name}</p>
                      <p className="text-slate-400 truncate">{type}</p>
                    </div>
                    <span className="text-[10px] font-medium shrink-0" style={{ color: cost === "Free" || cost === "Free tier" ? "#16a34a" : "#6b7280" }}>{cost}</span>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-slate-400 mt-1.5">Estimated total: <span className="font-semibold text-slate-600">~$18–25/mo</span> (varies by usage)</p>
            </div>

            {/* Actions */}
            <div className="flex gap-2.5">
              <button
                onClick={() => setShowDeployModal(false)}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-slate-600 hover:bg-slate-100 transition-colors"
                style={{ border:"1.5px solid rgba(0,0,0,0.1)" }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const name = deployAppName || "myphotos";
                  const url = `https://portal.azure.com/#create/Microsoft.Template/uri/${encodeURIComponent(TEMPLATE_URL)}` +
                    `?appName=${encodeURIComponent(name)}&location=${encodeURIComponent(deployRegion)}`;
                  window.open(url, "_blank", "noopener,noreferrer");
                }}
                disabled={!deployAppName || deployAppName.length < 3}
                className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white transition-all hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{
                  background:"linear-gradient(135deg,#0078d4 0%,#005a9e 100%)",
                  boxShadow:"0 6px 20px rgba(0,120,212,0.35)",
                }}
              >
                Open Azure Portal →
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
