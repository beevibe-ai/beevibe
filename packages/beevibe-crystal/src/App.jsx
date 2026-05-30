import { BrowserRouter, Routes, Route } from "react-router-dom";
import Upload from "./pages/Upload.jsx";
import Capsule from "./pages/Capsule.jsx";
import InboxPage from "./pages/Inbox.jsx";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Upload />} />
        <Route path="/c/:id" element={<Capsule />} />
        <Route path="/c/:id/inbox" element={<InboxPage />} />
      </Routes>
    </BrowserRouter>
  );
}
