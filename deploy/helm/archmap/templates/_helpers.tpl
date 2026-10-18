{{- define "archmap.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "archmap.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "archmap.selectorLabels" -}}
app.kubernetes.io/name: {{ include "archmap.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "archmap.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "archmap.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "archmap.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) }}
{{- end }}

{{/* Secret чарта нужен, если хоть одно из двух значений не взято из готового Secret */}}
{{- define "archmap.ownSecret" -}}
{{- if or (not .Values.database.existingSecret) (not .Values.secretKey.existingSecret) }}true{{ end }}
{{- end }}

{{/* Окружение пода: общее у init-контейнера миграций и у сервера */}}
{{- define "archmap.env" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.database.existingSecret | default (include "archmap.fullname" .) }}
      key: {{ if .Values.database.existingSecret }}{{ .Values.database.existingSecretKey }}{{ else }}database-url{{ end }}
- name: SECRET_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secretKey.existingSecret | default (include "archmap.fullname" .) }}
      key: {{ if .Values.secretKey.existingSecret }}{{ .Values.secretKey.existingSecretKey }}{{ else }}secret-key{{ end }}
- name: MAX_REQUEST_MB
  value: {{ .Values.config.maxRequestMb | quote }}
- name: LOGIN_ATTEMPTS_PER_MINUTE
  value: {{ .Values.config.loginAttemptsPerMinute | quote }}
- name: TRUST_FORWARDED_FOR
  value: {{ .Values.config.trustForwardedFor | quote }}
- name: WEB_CONCURRENCY
  value: {{ .Values.config.workers | quote }}
{{- with .Values.config.corsOrigins }}
- name: CORS_ORIGINS
  value: {{ . | quote }}
{{- end }}
{{- with .Values.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end }}
