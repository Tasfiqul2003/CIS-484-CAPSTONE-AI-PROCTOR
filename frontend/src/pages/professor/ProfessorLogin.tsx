import { useState } from "react";

export default function ProfessorLogin() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  function handleLogin(event: React.FormEvent) {
    event.preventDefault();

    if (!username.trim() || !password.trim()) {
      return;
    }

    window.location.href = "/professor/dashboard";
  }

  return (
    <div className="professor-login-page">

      <header className="simple-header">
        <div className="logo">
          <span className="logo-icon">◉</span>
          <span>OralExam AI</span>
        </div>
      </header>

      <main className="professor-login-content">

        <div className="professor-login-card">

          <div className="login-icon">
            ◉
          </div>

          <p className="eyebrow">
            PROFESSOR PORTAL
          </p>

          <h1>
            Professor Login
          </h1>

          <p className="login-description">
            Sign in to create and manage your oral examinations.
          </p>

          <form onSubmit={handleLogin}>

            <label htmlFor="username">
              Username
            </label>

            <input
              id="username"
              type="text"
              value={username}
              onChange={(event) =>
                setUsername(event.target.value)
              }
              placeholder="Enter your username"
            />

            <label htmlFor="password">
              Password
            </label>

            <input
              id="password"
              type="password"
              value={password}
              onChange={(event) =>
                setPassword(event.target.value)
              }
              placeholder="Enter your password"
            />

            <button
              type="submit"
              className="login-button"
            >
              Sign In
            </button>

          </form>

          <a
            href="/"
            className="back-home"
          >
            ← Back to Home
          </a>

        </div>

      </main>

      <footer className="home-footer">
        <p>OralExam AI</p>
        <p>AI-assisted oral examination platform</p>
      </footer>

    </div>
  );
}
