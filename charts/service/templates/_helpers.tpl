{{- define "service.name" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "service.selectorLabels" -}}
app.kubernetes.io/name: {{ include "service.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
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
