# Cloudflare Terraform — morrowind.virtastic.app

Declaratively manages the `virtastic.app` Cloudflare config for the OpenMW-Web deploy:
DNS record, SSL mode (Full strict), and the edge cache rule.

## What it does NOT do
- **Origin Certificate** — needs the Cloudflare *Origin CA key* (a different credential from the API
  token). Create it in the dashboard (SSL/TLS → Origin Server → Create Certificate for `virtastic.app`
  + `*.virtastic.app`), or generate a CSR on the VPS and paste it. Install at
  `/opt/nostalgia/certs/virtastic-origin.{crt,key}` on the box.

## Auth ("log in as your user")
Create a Cloudflare **API token** scoped to the `virtastic.app` zone with:
`Zone:Read`, `DNS:Edit`, `Cache Rules:Edit`, `Zone Settings:Edit`. Then:

```bash
export CLOUDFLARE_API_TOKEN=<your-token>
cd infra/terraform
terraform init
terraform plan      # review
terraform apply
```

State is local and gitignored (`*.tfstate`). Override any input via `-var` or a `terraform.tfvars`.
