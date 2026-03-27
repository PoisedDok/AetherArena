# Security Layer

This directory contains frontend-side security primitives used by the Electron app and renderer flows.

## Main modules

- `RateLimiter`
- `CspManager`
- `Sanitizer`
- `InputValidator`

## Responsibilities

- validate and constrain user-controlled input before it crosses boundaries
- sanitize renderer content before display
- manage Content Security Policy behavior in the frontend
- add client-side rate limiting where repeated calls could become abusive or unstable

## How to use this layer

- call validators before sending risky or user-provided payloads
- sanitize rich content before rendering it into the DOM
- keep CSP and rate-limiting policy here instead of scattering it through UI modules

## Design rule

This layer provides security primitives. It should not absorb application logic that belongs in domain, application, or renderer modules.

