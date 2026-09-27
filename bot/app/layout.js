export const metadata = {
  title: "AUREX DEVELOPMENT — Dashboard",
  description: "Deserve All Right.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="nl">
      <body
        style={{
          margin: 0,
          fontFamily: "Inter, system-ui, sans-serif",
          background: "#0b0b0d",
          color: "#f2f2f2",
          minHeight: "100vh",
        }}
      >
        {children}
      </body>
    </html>
  );
}
