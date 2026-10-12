# Public Supabase trust anchor

`supabase-root-2021.pem` is the public **Supabase Root 2021 CA**, downloaded over verified HTTPS from Supabase's certificate distribution URL:

https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt

DER SHA-256 fingerprint: `807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa`.

Valid until 26 April 2031. The setup script checks the fingerprint, CA property, self-signature and validity period, then enables TLS certificate **and hostname** verification. It never disables verification to work around a connection error. This file is a public CA certificate, not a private key or project credential.

See [Supabase's SSL verification guidance](https://supabase.com/docs/guides/platform/ssl-enforcement).
