use std::collections::HashMap;
use serde::{Deserialize, Serialize};

/// Execution target hardware backend chosen during capability negotiation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FilterTarget {
    /// Accelerated via WebGPU compute shader pipeline (10x-50x realtime for high-res video).
    WebGpuCompute,
    /// Executed via Pure Rust CPU SIMD / Software.
    CpuSimd,
    /// Stream metadata or timeline manipulation (e.g. fps, setpts, split).
    Passthrough,
}

/// A parsed single filter node inside the graph.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterNode {
    pub name: String,
    pub params: HashMap<String, String>,
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
    pub target: FilterTarget,
}

/// A validated Directed Acyclic Graph (DAG) of media filters.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterGraph {
    pub nodes: Vec<FilterNode>,
}

/// Parsing error for FFmpeg filtergraph strings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FilterParseError {
    EmptyFilterString,
    MalformedLabel(String),
    MalformedFilterSyntax(String),
    UnmatchedBrackets,
}

impl core::fmt::Display for FilterParseError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::EmptyFilterString => write!(f, "Filtergraph string is empty"),
            Self::MalformedLabel(s) => write!(f, "Malformed stream label: {}", s),
            Self::MalformedFilterSyntax(s) => write!(f, "Malformed filter syntax near: {}", s),
            Self::UnmatchedBrackets => write!(f, "Unmatched '[' or ']' in filtergraph"),
        }
    }
}

/// Determine the optimal hardware execution target for a filter.
pub fn negotiate_filter_target(filter_name: &str) -> FilterTarget {
    match filter_name {
        "scale" | "lanczos" | "bilateral_denoise" | "boxblur" | "grayscale" | "lut3d"
        | "histogram" | "colorbalance" | "invert" | "vignette" => FilterTarget::WebGpuCompute,

        "split" | "fps" | "trim" | "setpts" | "null" | "anull" => FilterTarget::Passthrough,

        "resample" | "volume" | "pan" | "equalizer" | "lowpass" | "highpass" => {
            FilterTarget::CpuSimd
        }

        _ => FilterTarget::CpuSimd, // Default to safe CPU execution
    }
}

/// Parse an FFmpeg `-vf` or `-filter_complex` string into a structured `FilterGraph`.
///
/// Handles:
/// - Linear chains: `scale=1280:720,fps=30,grayscale`
/// - Labeled complex graphs: `[0:v]split=2[v0][v1];[v0]scale=1280:720[out0];[v1]boxblur=2[out1]`
pub fn parse_filtergraph(filter_str: &str) -> Result<FilterGraph, FilterParseError> {
    let trimmed = filter_str.trim();
    if trimmed.is_empty() {
        return Err(FilterParseError::EmptyFilterString);
    }

    let mut nodes = Vec::new();

    // Semicolon separates distinct filter chains
    let chains = trimmed.split(';');

    for chain in chains {
        let chain_str = chain.trim();
        if chain_str.is_empty() {
            continue;
        }

        // Parse chained filters separated by commas (not inside quotes/brackets)
        let filter_tokens = split_filter_chain(chain_str)?;

        for (idx, token) in filter_tokens.iter().enumerate() {
            let node = parse_single_filter(token, idx == 0, idx == filter_tokens.len() - 1)?;
            nodes.push(node);
        }
    }

    Ok(FilterGraph { nodes })
}

/// Split a single chain by comma, respecting brackets e.g. `[a]scale=1:2[b],boxblur=2`
fn split_filter_chain(chain: &str) -> Result<Vec<String>, FilterParseError> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_bracket = false;

    for c in chain.chars() {
        match c {
            '[' => {
                in_bracket = true;
                current.push(c);
            }
            ']' => {
                in_bracket = false;
                current.push(c);
            }
            ',' if !in_bracket => {
                let s = current.trim();
                if !s.is_empty() {
                    tokens.push(s.to_string());
                }
                current.clear();
            }
            _ => {
                current.push(c);
            }
        }
    }

    if in_bracket {
        return Err(FilterParseError::UnmatchedBrackets);
    }

    let s = current.trim();
    if !s.is_empty() {
        tokens.push(s.to_string());
    }

    Ok(tokens)
}

fn parse_single_filter(
    token: &str,
    _is_first: bool,
    _is_last: bool,
) -> Result<FilterNode, FilterParseError> {
    let mut input_labels = Vec::new();
    let mut output_labels = Vec::new();
    let mut s = token.trim();

    // Extract leading input labels: e.g. `[0:v][1:v]`
    while s.starts_with('[') {
        if let Some(close_idx) = s.find(']') {
            let label = s[1..close_idx].trim().to_string();
            if label.is_empty() {
                return Err(FilterParseError::MalformedLabel(s.to_string()));
            }
            input_labels.push(label);
            s = s[close_idx + 1..].trim();
        } else {
            return Err(FilterParseError::UnmatchedBrackets);
        }
    }

    // Extract trailing output labels: e.g. `[out0][out1]`
    while s.ends_with(']') {
        if let Some(open_idx) = s.rfind('[') {
            let label = s[open_idx + 1..s.len() - 1].trim().to_string();
            if label.is_empty() {
                return Err(FilterParseError::MalformedLabel(s.to_string()));
            }
            output_labels.insert(0, label);
            s = s[..open_idx].trim();
        } else {
            return Err(FilterParseError::UnmatchedBrackets);
        }
    }

    // Now `s` contains the filter name and arguments, e.g. `scale=1280:720` or `grayscale`
    let (filter_name, params) = if let Some(eq_pos) = s.find('=') {
        let name = s[..eq_pos].trim().to_string();
        let args_str = s[eq_pos + 1..].trim();
        let params_map = parse_filter_arguments(&name, args_str);
        (name, params_map)
    } else {
        (s.to_string(), HashMap::new())
    };

    if filter_name.is_empty() {
        return Err(FilterParseError::MalformedFilterSyntax(token.to_string()));
    }

    let target = negotiate_filter_target(&filter_name);

    Ok(FilterNode {
        name: filter_name,
        params,
        inputs: input_labels,
        outputs: output_labels,
        target,
    })
}

fn parse_filter_arguments(filter_name: &str, args: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let parts: Vec<&str> = args.split(':').map(|p| p.trim()).collect();

    for (i, part) in parts.iter().enumerate() {
        if let Some(eq_pos) = part.find('=') {
            let k = part[..eq_pos].trim().to_string();
            let v = part[eq_pos + 1..].trim().to_string();
            map.insert(k, v);
        } else {
            // Positional argument fallbacks for popular filters
            match filter_name {
                "scale" => {
                    if i == 0 {
                        map.insert("width".to_string(), part.to_string());
                    } else if i == 1 {
                        map.insert("height".to_string(), part.to_string());
                    }
                }
                "fps" => {
                    if i == 0 {
                        map.insert("fps".to_string(), part.to_string());
                    }
                }
                "boxblur" => {
                    if i == 0 {
                        map.insert("luma_radius".to_string(), part.to_string());
                    } else if i == 1 {
                        map.insert("luma_power".to_string(), part.to_string());
                    }
                }
                "volume" => {
                    if i == 0 {
                        map.insert("volume".to_string(), part.to_string());
                    }
                }
                _ => {
                    map.insert(format!("arg{}", i), part.to_string());
                }
            }
        }
    }

    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_simple_linear_filter_chain() {
        let fg = parse_filtergraph("scale=1280:720,fps=30,grayscale").unwrap();
        assert_eq!(fg.nodes.len(), 3);

        assert_eq!(fg.nodes[0].name, "scale");
        assert_eq!(fg.nodes[0].target, FilterTarget::WebGpuCompute);
        assert_eq!(fg.nodes[0].params.get("width").map(|s| s.as_str()), Some("1280"));
        assert_eq!(fg.nodes[0].params.get("height").map(|s| s.as_str()), Some("720"));

        assert_eq!(fg.nodes[1].name, "fps");
        assert_eq!(fg.nodes[1].target, FilterTarget::Passthrough);
        assert_eq!(fg.nodes[1].params.get("fps").map(|s| s.as_str()), Some("30"));

        assert_eq!(fg.nodes[2].name, "grayscale");
        assert_eq!(fg.nodes[2].target, FilterTarget::WebGpuCompute);
    }

    #[test]
    fn test_parse_complex_labeled_graph() {
        let fg = parse_filtergraph(
            "[0:v]split=2[v0][v1];[v0]scale=w=1920:h=1080[out0];[v1]boxblur=2:1[out1]",
        )
        .unwrap();

        assert_eq!(fg.nodes.len(), 3);

        // Node 0: split
        assert_eq!(fg.nodes[0].name, "split");
        assert_eq!(fg.nodes[0].inputs, vec!["0:v"]);
        assert_eq!(fg.nodes[0].outputs, vec!["v0", "v1"]);

        // Node 1: scale
        assert_eq!(fg.nodes[1].name, "scale");
        assert_eq!(fg.nodes[1].inputs, vec!["v0"]);
        assert_eq!(fg.nodes[1].outputs, vec!["out0"]);
        assert_eq!(fg.nodes[1].params.get("w").map(|s| s.as_str()), Some("1920"));
        assert_eq!(fg.nodes[1].target, FilterTarget::WebGpuCompute);

        // Node 2: boxblur
        assert_eq!(fg.nodes[2].name, "boxblur");
        assert_eq!(fg.nodes[2].inputs, vec!["v1"]);
        assert_eq!(fg.nodes[2].outputs, vec!["out1"]);
        assert_eq!(fg.nodes[2].target, FilterTarget::WebGpuCompute);
    }

    #[test]
    fn test_empty_and_malformed_syntax() {
        assert_eq!(parse_filtergraph("").unwrap_err(), FilterParseError::EmptyFilterString);
        assert_eq!(parse_filtergraph("[0:v]scale[").unwrap_err(), FilterParseError::UnmatchedBrackets);
    }
}
