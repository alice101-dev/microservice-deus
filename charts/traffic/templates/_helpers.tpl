{{- define "traffic.name" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "traffic.selectorLabels" -}}
app.kubernetes.io/name: {{ include "traffic.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "traffic.labels" -}}
{{ include "traffic.selectorLabels" . }}
app.kubernetes.io/component: load-generator
app.kubernetes.io/version: {{ .Values.k6.image.tag | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}
