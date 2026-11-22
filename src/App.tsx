import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import Sidebar from "@/components/Sidebar";
import Office from "@/pages/Office";
import Tasks from "@/pages/Tasks";
import Activity from "@/pages/Activity";
import Agents from "@/pages/Agents";
import Forms from "@/pages/Forms";
import FormSubmissions from "@/pages/FormSubmissions";
import Webhooks from "@/pages/Webhooks";
import Integrations from "@/pages/Integrations";
import Voice from "@/pages/Voice";
import VoiceInvitationBanner from "@/components/VoiceInvitationBanner";
import LiveAgentFeed from "@/components/LiveAgentFeed";
import Pages from "@/pages/Pages";
import PublicForm from "@/pages/PublicForm";
import Settings from "@/pages/Settings";
import Outreach from "@/pages/Outreach";
import CampaignDetail from "@/pages/CampaignDetail";
import Prospects from "@/pages/Prospects";
import Inbox from "@/pages/Inbox";
import FollowUps from "@/pages/FollowUps";
import Analytics from "@/pages/Analytics";
import SignInGate from "@/components/SignInGate";

export default function App() {
  return (
    <>
      <SignInGate />
      <div className="app-bg" />
      <div className="grid-bg" />

      <Routes>
        <Route path="/form/:slug" element={<PublicForm />} />
        <Route path="/*" element={<Shell />} />
      </Routes>
    </>
  );
}

function Shell() {
  const loc = useLocation();
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <VoiceInvitationBanner />
      <LiveAgentFeed />
      <main className="flex-1 min-w-0 px-4 sm:px-10 py-8 max-w-[1600px] mx-auto w-full">
        <ErrorBoundary label="This page" resetKey={loc.pathname}>
        <Routes>
          <Route path="/" element={<Office />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/activity" element={<Activity />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/voice" element={<Voice />} />
          <Route path="/forms" element={<Forms />} />
          <Route path="/forms/:slug" element={<FormSubmissions />} />
          <Route path="/pages" element={<Pages />} />
          <Route path="/outreach" element={<Outreach />} />
          <Route path="/outreach/:id" element={<CampaignDetail />} />
          <Route path="/prospects" element={<Prospects />} />
          <Route path="/followups" element={<FollowUps />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/webhooks" element={<Webhooks />} />
          <Route path="/integrations" element={<Integrations />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </ErrorBoundary>
      </main>
    </div>
  );
}
