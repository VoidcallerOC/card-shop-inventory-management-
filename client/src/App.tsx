import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import DashboardLayout from "@/components/DashboardLayout";
import ErrorBoundary from "@/components/ErrorBoundary";
import { ThemeProvider } from "@/contexts/ThemeContext";
import Home from "@/pages/Home";
import Inventory from "@/pages/Inventory";
import MovementLedger from "@/pages/MovementLedger";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";

function Router() {
  return <DashboardLayout><Switch><Route path="/" component={Home} /><Route path="/inventory" component={Inventory} /><Route path="/movements" component={MovementLedger} /><Route path="/404" component={NotFound} /><Route component={NotFound} /></Switch></DashboardLayout>;
}

export default function App() {
  return <ErrorBoundary><ThemeProvider defaultTheme="light"><TooltipProvider><Toaster position="top-right" richColors /><Router /></TooltipProvider></ThemeProvider></ErrorBoundary>;
}
