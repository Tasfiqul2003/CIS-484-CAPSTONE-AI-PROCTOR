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
      <a className="student-skip-link" href="#main-content">Skip to content</a>
      <header className="home-header">
        <a className="logo" href="/" aria-label="OralExam AI home">
          <span className="logo-icon" aria-hidden="true">
            <OralExamMark size={34} />
          </span>
          <span>OralExam AI</span>
        </a>
        <span className="home-header-note">
          <Sparkles size={15} aria-hidden="true" />
          JMU oral exams
        </span>
      </header>

      <main id="main-content" className="home-content" aria-labelledby="home-title">
        <section className="hero-section" aria-labelledby="home-title">
          <div className="hero-text">
            <h1 id="home-title">
              Oral exams,
              <span> made clearer.</span>
            </h1>

            <p className="hero-description">A focused exam experience for JMU students and instructors.</p>
          </div>

          <div className="role-selection">
            <h2>Choose a portal</h2>

            <div className="role-cards">
              <a className="role-card" href="/student/verification">
                <span className="role-icon" aria-hidden="true">
                  <UserRound size={22} strokeWidth={1.9} />
                </span>
                <span className="role-card-content">
                  <span className="home-role-label">Student portal</span>
                  <span className="role-card-title">Student</span>
                  <span className="role-card-description">
                  View assigned exams.
                  </span>
                </span>
                <ArrowRight className="arrow" size={20} aria-hidden="true" />
              </a>

              <a className="role-card" href="/professor/login">
                <span className="role-icon" aria-hidden="true">
                  <GraduationCap size={23} strokeWidth={1.9} />
                </span>
                <span className="role-card-content">
                  <span className="home-role-label">Professor portal</span>
                  <span className="role-card-title">Professor</span>
                  <span className="role-card-description">
                  Create exams and review submissions.
                  </span>
                </span>
                <ArrowRight className="arrow" size={20} aria-hidden="true" />
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="home-footer">
        <p>OralExam AI · James Madison University</p>
      </footer>
    </div>
  );
}
