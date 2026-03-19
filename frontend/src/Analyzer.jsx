import { useState } from "react";
import { apiFetch, setToken } from "./api";

export default function Analyzer() {
  const [file, setFile] = useState(null);
  const [score, setScore] = useState(null);
  const [feedback, setFeedback] = useState("");
  const [strengths, setStrengths] = useState([]);
  const [improvements, setImprovements] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleUpload = async () => {
    if (!file) {
      alert("Upload resume first");
      return;
    }

    const formData = new FormData();
    formData.append("resume", file);

    try {
      setError("");
      setLoading(true);
      const data = await apiFetch("/analyze", { method: "POST", body: formData });
      setScore(data.score);
      setFeedback(data.feedback);
      setStrengths(Array.isArray(data.strengths) ? data.strengths : []);
      setImprovements(Array.isArray(data.improvements) ? data.improvements : []);
    } catch (err) {
      setError(err.message || "Analyze failed");
    } finally {
      setLoading(false);
    }
  };

  const logout = () => {
    setToken(null);
    window.location.href = "/login";
  };

  return (
    <div className="container">
      <div className="topBar">
        <h1>AI Resume Analyzer</h1>
        <button onClick={logout} className="secondary">
          Logout
        </button>
      </div>

      <input
        type="file"
        accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        onChange={(e) => setFile(e.target.files[0])}
      />

      <button onClick={handleUpload} disabled={loading}>
        {loading ? "Analyzing..." : "Analyze Resume"}
      </button>

      {error && <p className="error">{error}</p>}

      {score !== null && (
        <div className="result">
          <h2>Score: {score}/100</h2>
          <p>{feedback}</p>

          {strengths.length > 0 && (
            <div className="panel">
              <h3>What’s good</h3>
              <ul>
                {strengths.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          )}

          {improvements.length > 0 && (
            <div className="panel">
              <h3>What to strengthen</h3>
              <ul>
                {improvements.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          )}

          <button onClick={handleUpload} className="secondary">
            Re-analyze
          </button>
        </div>
      )}
    </div>
  );
}

