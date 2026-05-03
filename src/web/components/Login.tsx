export default function Login() {
  return (
    <div className="login-screen">
      <img src="/fifos.png" alt="Fifos" className="login-logo" />
      <h1>Fifos</h1>
      <p>FIFO queues for AI work. Push, pop, pull, done.</p>
      <a
        href="/auth/login"
        className="btn"
        style={{
          display: "inline-block",
          textAlign: "center",
          textDecoration: "none",
        }}
      >
        Login with Legendum
      </a>
    </div>
  );
}
