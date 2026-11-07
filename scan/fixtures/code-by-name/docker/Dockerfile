FROM eclipse-temurin:17 AS builder
ARG ARTIFACT_NAME
COPY ${ARTIFACT_NAME}.jar application.jar
FROM eclipse-temurin:17
ENTRYPOINT ["java", "org.springframework.boot.loader.launch.JarLauncher"]
