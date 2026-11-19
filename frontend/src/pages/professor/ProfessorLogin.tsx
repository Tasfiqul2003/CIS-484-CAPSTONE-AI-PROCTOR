import PortalThemeToggle from "../../components/theme/PortalThemeToggle";

import { useState, type FormEvent } from "react";
import OralExamMark from "../../components/brand/OralExamMark";

export default function ProfessorLogin() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    if (!username.trim() || !password) {
      setError("Please enter your username and password.");
      return;
    }

    setLoading(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          username: username.trim(),
          password,
        }),
      });

      if (!response.ok) {
        let message = response.status === 401
          ? "Login failed. Check your username and password."
          : response.status >= 500
            ? "The login service is unavailable. Try again when the backend is ready."
            : "Unable to sign in. Please try again.";

        try {
          const data = await response.json();
          if (response.status < 500 && typeof data.detail === "string") {
            message = data.detail;
          } else if (response.status < 500 && typeof data.message === "string") {
            message = data.message;
          }
        } catch {
          // Keep the default error message if the response isn't JSON.
        }

        setError(message);
        return;
      }

      window.location.href = "/professor/dashboard";
    } catch {
      setError(
        "Unable to connect to the server. Make sure the backend is running."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="professor-login-page">
      <header className="simple-header">
        <a className="logo" href="/" aria-label="OralExam AI home">
          <span className="logo-icon" aria-hidden="true"><OralExamMark size={34} /></span>
          <span>OralExam AI</span>
        </a>
        <PortalThemeToggle />
      </header>

      <main className="professor-login-content">
        <div className="professor-login-split">
        <div className="professor-login-card">
          <div className="login-icon" aria-hidden="true"><OralExamMark size={56} /></div>

          <p className="eyebrow">PROFESSOR PORTAL</p>

          <h1>Professor Login</h1>

          <p className="login-description">
            Sign in to create and manage your oral examinations.
          </p>

          <form onSubmit={handleLogin}>
            <label htmlFor="username">Username</label>
            <input
              id="username"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="Enter your username"
              required
            />

            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter your password"
              required
            />

            {error && (
              <p role="alert" className="login-error">
                {error}
              </p>
            )}

            <button
              type="submit"
              className="login-button"
              disabled={loading}
            >
              {loading ? "Signing In..." : "Sign In"}
            </button>
          </form>

          <a href="/" className="back-home">
            ← Back to Home
          </a>
        </div>
        <aside className="professor-login-art" aria-hidden="true">
          <img className="professor-login-mascot" src="/brand/duke-dog.png" alt="" width="411" height="480" />
          <p className="professor-login-art-title">Oral exams, made clearer.</p>
          <p>Build question banks, run AI-assisted oral exams, and review every recording and transcript in one place.</p>
          <svg className="professor-login-wave" viewBox="0 0 320 80" role="presentation">
            {Array.from({ length: 32 }, (_, i) => {
              const h = 12 + Math.round(52 * Math.abs(Math.sin(i * 0.55) * Math.cos(i * 0.21)));
              return <rect key={i} x={i * 10 + 2} y={40 - h / 2} width="6" height={h} rx="3" />;
            })}
          </svg>
        </aside>
        </div>
      </main>

      <footer className="home-footer">
        <p>OralExam AI</p>
        <p>AI-assisted oral examination platform</p>
      </footer>
    </div>
  );
}
