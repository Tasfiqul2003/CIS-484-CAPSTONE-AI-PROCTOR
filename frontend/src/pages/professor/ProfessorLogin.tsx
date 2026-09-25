export default function ProfessorLogin() {
  return (
    <div className="login-page">
      <header className="simple-header">
        <div className="logo">
          <span className="logo-icon">◉</span>
          <span>OralExam AI</span>
        </div>
      </header>

      <main className="login-content">
        <div className="login-card">
          <div className="login-icon">▣</div>

          <p className="eyebrow">PROFESSOR PORTAL</p>

          <h1>Welcome back</h1>

          <p className="login-description">
            Sign in to manage your oral examinations, questions, materials,
            and student submissions.
          </p>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              window.location.href = "/professor/dashboard";
            }}
          >
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              placeholder="professor@jmu.edu"
              required
            />

            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              placeholder="Enter your password"
              required
            />

            <button type="submit" className="login-button">
              Sign In
            </button>
          </form>

          <button
            className="back-button"
            onClick={() => (window.location.href = "/")}
          >
            ← Back to Home
          </button>
        </div>
      </main>
    </div>
  );
}
