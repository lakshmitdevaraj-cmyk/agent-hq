import { Routes, Route, Navigate } from "react-router-dom";
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
import Inbox from "@/pages/Inbox";
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
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <VoiceInvitationBanner />
      <LiveAgentFeed />
      <main className="flex-1 px-10 py-8 max-w-[1600px] mx-auto w-full">
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
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/webhooks" element={<Webhooks />} />
          <Route path="/integrations" element={<Integrations />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
