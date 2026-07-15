// Типы подпути swagger-ui-dist: @types/swagger-ui-dist описывает только главный
// вход пакета, а мы грузим es-bundle (модульная сборка) динамическим import().
declare module "swagger-ui-dist/swagger-ui-es-bundle.js" {
  import type { SwaggerUIBundle } from "swagger-ui-dist";
  const bundle: SwaggerUIBundle;
  export default bundle;
}
