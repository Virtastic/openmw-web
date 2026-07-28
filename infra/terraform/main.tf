# Cloudflare config for morrowind.virtastic.app (the OpenMW-Web deploy on the shared OVH VPS).
# Manages DNS + SSL mode + edge caching declaratively. The Origin Certificate is handled separately
# (dashboard, or a scoped origin-CA step) since it needs a different credential than the API token.
#
# Auth: export CLOUDFLARE_API_TOKEN=... (a token scoped to the virtastic.app zone with
#   Zone:Read, DNS:Edit, Cache Rules:Edit, Zone Settings:Edit). Then: terraform init && terraform apply

terraform {
  required_version = ">= 1.5"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.30"
    }
  }
}

provider "cloudflare" {
  # Reads CLOUDFLARE_API_TOKEN from the environment (do NOT commit the token).
}

data "cloudflare_zone" "this" {
  name = var.zone_name
}

# DNS: morrowind.virtastic.app -> the OVH VPS, proxied (orange cloud) so Cloudflare fronts it.
resource "cloudflare_record" "morrowind" {
  zone_id = data.cloudflare_zone.this.id
  name    = "morrowind"
  type    = "A"
  content = var.origin_ip
  proxied = true
  ttl     = 1 # 1 = automatic (required when proxied)
  comment = "OpenMW-Web on the shared OVH VPS (managed by terraform)"
}

# NOTE: SSL mode (Full strict) and Rocket Loader (off) are set out-of-band via the Cloudflare API
# (a one-time PATCH to /zones/<id>/settings/{ssl,rocket_loader}), NOT here. The
# `cloudflare_zone_settings_override` resource reads ALL ~40 zone settings and errors if the token
# can't read any newer one (e.g. speed_brain), which made it unusable — so it's intentionally omitted.

# Edge caching: cache the immutable engine/game assets aggressively; let HTML respect origin no-cache.
# The origin (container Caddy) already sends correct Cache-Control; this is the edge optimization.
resource "cloudflare_ruleset" "cache" {
  zone_id = data.cloudflare_zone.this.id
  name    = "morrowind-cache"
  kind    = "zone"
  phase   = "http_request_cache_settings"

  rules {
    ref         = "morrowind_assets"
    description = "Cache-everything for morrowind.virtastic.app immutable assets"
    expression  = "(http.host eq \"${var.hostname}\" and http.request.uri.path.extension in {\"wasm\" \"data\" \"js\" \"br\" \"bsa\" \"esm\" \"tar\" \"png\" \"jpg\" \"css\"})"
    action      = "set_cache_settings"
    enabled     = true
    action_parameters {
      cache = true
      edge_ttl {
        mode    = "override_origin"
        default = 2592000 # 30 days at the edge for the big immutable blobs
      }
      browser_ttl {
        mode = "respect_origin" # honor the origin's Cache-Control (immutable / no-cache)
      }
    }
  }
}
