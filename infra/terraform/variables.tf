variable "zone_name" {
  description = "Cloudflare zone (root domain)"
  type        = string
  default     = "virtastic.app"
}

variable "hostname" {
  description = "Public hostname for the deploy"
  type        = string
  default     = "morrowind.virtastic.app"
}

variable "origin_ip" {
  description = "Origin server (OVH VPS) IPv4 — the DNS A-record target. NOT committed: supply it at apply time via a gitignored terraform.tfvars (see terraform.tfvars.example) or TF_VAR_origin_ip, so the origin address stays out of the public repo."
  type        = string
  # No default on purpose — the origin IP is sensitive (Cloudflare fronts it) and must not live in git.
}
