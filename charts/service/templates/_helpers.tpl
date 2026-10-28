{{- define "service.name" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "service.selectorLabels" -}}
app.kubernetes.io/name: {{ include "service.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "service.serverSelectorLabels" -}}
{{ include "service.selectorLabels" . }}
app.kubernetes.io/component: server
{{- end -}}

{{- define "service.labels" -}}
{{ include "service.selectorLabels" . }}
app.kubernetes.io/part-of: {{ .Values.partOf }}
app.kubernetes.io/version: {{ .Values.image.tag | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "service.image" -}}
{{- $registry := required "image.registry is required" .Values.image.registry -}}
{{- $repository := required "image.repository is required" .Values.image.repository -}}
{{- $tag := required "image.tag is required" .Values.image.tag -}}
{{- printf "%s/%s:%s" $registry $repository $tag -}}
{{- end -}}

{{- define "service.databaseName" -}}
{{- default (include "service.name" .) .Values.database.name -}}
{{- end -}}

{{- define "service.securityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end -}}

{{- define "service.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 65532
runAsGroup: 65532
fsGroup: 65532
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "service.commonEnv" -}}
- name: SERVICE_NAME
  value: {{ include "service.name" . | quote }}
- name: SERVICE_VERSION
  value: {{ .Values.image.tag | quote }}
- name: SERVICE_NAMESPACE
  value: {{ .Values.partOf | quote }}
- name: DEPLOYMENT_ENVIRONMENT
  value: {{ .Values.environment | quote }}
- name: LOG_LEVEL
  value: {{ .Values.logLevel | quote }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ .Values.telemetry.endpoint | quote }}
- name: OTEL_METRIC_EXPORT_INTERVAL
  value: {{ .Values.telemetry.metricExportIntervalMs | quote }}
{{- end -}}

{{- define "service.databaseEnv" -}}
{{- $secret := printf "%s-%s-%s" .context.Values.database.cluster (include "service.name" .context) .role -}}
- name: DB_HOST
  value: {{ printf "%s-rw" .context.Values.database.cluster | quote }}
- name: DB_PORT
  value: {{ .context.Values.database.port | quote }}
- name: DB_NAME
  value: {{ include "service.databaseName" .context | quote }}
- name: DB_USER
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: username
- name: DB_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: password
{{- end -}}

