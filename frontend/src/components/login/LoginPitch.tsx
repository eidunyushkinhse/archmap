// Левая половина экрана входа: знак, заголовок и анимированное превью схемы. Общая
// для обычного входа и демо-входа (docs/tasks/demo-mode.md): правая половина у них
// своя, левая одна. Стили — в pages/LoginPage.css (их подключают обе страницы).
import BrandLink from "../../ui/BrandLink";
import LoginScenePreview from "./LoginScenePreview";

export default function LoginPitch() {
  return (
    <section className="login-left">
      <BrandLink />
      <div className="login-pitch">
        <h1>Документация, понятная вам и вашим агентам</h1>
        <p>Архитектура, логика и бизнес-процессы в одном месте.</p>
      </div>
      <div className="login-canvas">
        <LoginScenePreview />
      </div>
    </section>
  );
}
