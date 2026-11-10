import {
  ArrowRight,
  GraduationCap,
  Sparkles,
  UserRound,
} from "lucide-react";
import OralExamMark from "../components/brand/OralExamMark";

export default function Home() {
  return (
    <div className="home-page">
      <header className="home-header">
        <a className="logo" href="/" aria-label="OralExam AI home">
          <span className="logo-icon" aria-hidden="true">
            <OralExamMark size={34} />
          </span>
          <span>OralExam AI</span>
        </a>
        <span className="home-header-note">
          <Sparkles size={15} aria-hidden="true" />
          Thoughtful oral assessment
        </span>
      </header>

      <main className="home-content">
        <section className="hero-section" aria-labelledby="home-title">
          <div className="hero-text">
            <p className="eyebrow">
              <span className="home-eyebrow-mark" aria-hidden="true" />
              AI-powered oral examinations
            </p>

            <h1 id="home-title">
              A clearer way to
              <span> assess understanding.</span>
            </h1>

            <p className="hero-description">
              OralExam AI helps professors prepare and manage oral exams, while
              giving students a focused way to demonstrate what they know.
            </p>
          </div>

          <div className="role-selection">
            <h2>Choose your portal</h2>
            <p className="home-section-description">
              Select how you’re using OralExam AI to continue.
            </p>

            <div className="role-cards">
              <button
                type="button"
                className="role-card"
                onClick={() => {
                  window.location.href = "/student/verification";
                }}
              >
                <span className="role-icon" aria-hidden="true">
                  <UserRound size={22} strokeWidth={1.9} />
                </span>
                <span className="role-card-content">
                  <span className="role-card-title">Student Portal</span>
                  <span className="role-card-description">
                    Verify your identity and access the exams assigned to you.
                  </span>
                </span>
                <ArrowRight className="arrow" size={20} aria-hidden="true" />
              </button>

              <button
                type="button"
                className="role-card"
                onClick={() => {
                  window.location.href = "/professor/login";
                }}
              >
                <span className="role-icon" aria-hidden="true">
                  <GraduationCap size={23} strokeWidth={1.9} />
                </span>
                <span className="role-card-content">
                  <span className="role-card-title">Professor Portal</span>
                  <span className="role-card-description">
                    Sign in to create exams, manage course materials, and
                    review submissions.
                  </span>
                </span>
                <ArrowRight className="arrow" size={20} aria-hidden="true" />
              </button>
            </div>
          </div>
        </section>

        <section className="features-section" aria-label="Platform features">
          <article className="feature">
            <h3>Interactive oral exams</h3>
            <p>Students respond verbally in a guided exam experience.</p>
          </article>

          <article className="feature">
            <h3>Identity verification</h3>
            <p>Verification steps help connect each exam to its student.</p>
          </article>

          <article className="feature">
            <h3>Professor controls</h3>
            <p>Manage exams, question banks, materials, and submissions.</p>
          </article>
        </section>
      </main>

      <footer className="home-footer">
        <p>OralExam AI</p>
        <p>AI-assisted oral examination platform</p>
      </footer>
    </div>
  );
}
