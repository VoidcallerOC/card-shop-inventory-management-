import { useAuth } from "@/_core/hooks/useAuth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { startLogin } from "@/const";
import { useIsMobile } from "@/hooks/useMobile";
import { BookOpenCheck, Boxes, LayoutDashboard, LogOut, PanelLeft, Plus } from "lucide-react";
import { CSSProperties, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from "./DashboardLayoutSkeleton";
import { Button } from "./ui/button";

const menuItems = [
  { icon: LayoutDashboard, label: "Overview", path: "/", marker: "01" },
  { icon: Boxes, label: "Inventory", path: "/inventory", marker: "02" },
  { icon: BookOpenCheck, label: "Movement ledger", path: "/movements", marker: "03" },
];
const SIDEBAR_WIDTH_KEY = "card-vault-sidebar-width";
const DEFAULT_WIDTH = 286;
const MIN_WIDTH = 230;
const MAX_WIDTH = 420;

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [sidebarWidth, setSidebarWidth] = useState(() => Number(localStorage.getItem(SIDEBAR_WIDTH_KEY)) || DEFAULT_WIDTH);
  const { loading, user } = useAuth();
  useEffect(() => { localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString()); }, [sidebarWidth]);
  if (loading) return <DashboardLayoutSkeleton />;
  if (!user) return <div className="auth-shell"><div className="auth-card"><div className="vault-seal">V</div><p className="eyebrow">Card shop operations</p><h1>Welcome to the <span>vault.</span></h1><p>Sign in to manage stock, record movements, and keep your card inventory accountable.</p><Button onClick={() => startLogin()} className="button-primary w-full">Sign in to continue</Button></div></div>;
  return <SidebarProvider style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}><DashboardLayoutContent setSidebarWidth={setSidebarWidth}>{children}</DashboardLayoutContent></SidebarProvider>;
}

function DashboardLayoutContent({ children, setSidebarWidth }: { children: React.ReactNode; setSidebarWidth: (width: number) => void }) {
  const { user, logout } = useAuth();
  const [location, setLocation] = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const isCollapsed = state === "collapsed";
  const active = menuItems.find(item => location.startsWith(item.path === "/" ? "?" : item.path)) ?? (location === "/" ? menuItems[0] : undefined);
  useEffect(() => { const move = (event: MouseEvent) => { if (!isResizing) return; const left = sidebarRef.current?.getBoundingClientRect().left ?? 0; const width = event.clientX - left; if (width >= MIN_WIDTH && width <= MAX_WIDTH) setSidebarWidth(width); }; const up = () => setIsResizing(false); if (isResizing) { document.addEventListener("mousemove", move); document.addEventListener("mouseup", up); document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none"; } return () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); document.body.style.cursor = ""; document.body.style.userSelect = ""; }; }, [isResizing, setSidebarWidth]);
  return <><div ref={sidebarRef} className="relative"><Sidebar collapsible="icon" className="vault-sidebar border-r-0" disableTransition={isResizing}><SidebarHeader className="vault-header"><div className="flex items-center gap-3"><button onClick={toggleSidebar} className="sidebar-toggle" aria-label="Toggle navigation"><PanelLeft size={18} /></button>{!isCollapsed && <div className="brand-lockup"><div className="brand-mark">V</div><div><strong>Vaultline</strong><span>Inventory control</span></div></div>}</div></SidebarHeader><SidebarContent className="vault-content"><div className="sidebar-section-label">Management</div><SidebarMenu className="px-3 py-1">{menuItems.map(item => <SidebarMenuItem key={item.path}><SidebarMenuButton isActive={location === item.path} onClick={() => setLocation(item.path)} tooltip={item.label} className="vault-nav-item"><item.icon size={17} /><span>{item.label}</span><em>{item.marker}</em></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu><div className="sidebar-spacer" />{!isCollapsed && <div className="sidebar-footnote"><span className="eyebrow">Stock integrity</span><p>Every adjustment is recorded in the permanent ledger.</p></div>}</SidebarContent><SidebarFooter className="vault-footer"><button onClick={() => setLocation("/inventory?new=1")} className="sidebar-add"><Plus size={16} /><span>Add inventory</span></button><DropdownMenu><DropdownMenuTrigger asChild><button className="profile-trigger"><Avatar><AvatarFallback>{user?.name?.charAt(0).toUpperCase() || "S"}</AvatarFallback></Avatar>{!isCollapsed && <div><strong>{user?.name || "Staff member"}</strong><span>{user?.role || "user"}</span></div>}</button></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-52"><DropdownMenuItem onClick={logout} className="cursor-pointer text-destructive focus:text-destructive"><LogOut className="mr-2 h-4 w-4" />Sign out</DropdownMenuItem></DropdownMenuContent></DropdownMenu></SidebarFooter></Sidebar><div className={`resize-rail ${isCollapsed ? "hidden" : ""}`} onMouseDown={() => setIsResizing(true)} /></div><SidebarInset>{isMobile && <header className="mobile-header"><SidebarTrigger className="rounded-xl" /><div><strong>Vaultline</strong><span>{active?.label || "Inventory"}</span></div></header>}<main className="app-main">{children}</main></SidebarInset></>;
}
