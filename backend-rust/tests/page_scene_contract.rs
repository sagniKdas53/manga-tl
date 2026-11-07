use manga_backend::page_scene::{validate_against_schema, validate_page_scene};
use serde_json::Value;

const FIXTURES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../contracts/fixtures/page-scene-v1/"
);

fn fixture(name: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(format!("{FIXTURES}{name}")).unwrap()).unwrap()
}

fn pointer_parent<'a>(document: &'a mut Value, pointer: &str) -> (&'a mut Value, String) {
    let parts = pointer
        .trim_start_matches('/')
        .split('/')
        .map(|part| part.replace("~1", "/").replace("~0", "~"))
        .collect::<Vec<_>>();
    let key = parts.last().unwrap().clone();
    let mut parent = document;
    for part in &parts[..parts.len() - 1] {
        parent = if parent.is_array() {
            parent
                .as_array_mut()
                .and_then(|array| array.get_mut(part.parse::<usize>().unwrap()))
        } else {
            parent.get_mut(part)
        }
        .unwrap_or_else(|| panic!("missing fixture pointer segment {part} in {pointer}"));
    }
    (parent, key)
}

fn apply_operation(document: &mut Value, operation: &Value) {
    let (parent, key) = pointer_parent(document, operation["path"].as_str().unwrap());
    match operation["op"].as_str().unwrap() {
        "replace" | "add" => parent[key] = operation["value"].clone(),
        "remove" => {
            if let Some(array) = parent.as_array_mut() {
                array.remove(key.parse().unwrap());
            } else {
                parent.as_object_mut().unwrap().remove(&key);
            }
        }
        operation => panic!("unsupported fixture operation {operation}"),
    }
}

#[test]
fn accepts_every_shared_valid_fixture() {
    for name in [
        "logical-valid.json",
        "resolved-valid.json",
        "overlap-preserve-valid.json",
        "inpainting-edits-valid.json",
    ] {
        let scene = fixture(name);
        let validated =
            validate_page_scene(scene.clone()).unwrap_or_else(|error| panic!("{name}: {error}"));
        assert!(
            validate_page_scene(serde_json::to_value(validated.document).unwrap()).is_ok(),
            "{name} must round-trip"
        );
    }
}

#[test]
fn rejects_every_shared_invalid_fixture() {
    assert!(
        serde_json::from_str::<Value>(
            &std::fs::read_to_string(format!("{FIXTURES}non-finite-geometry.json")).unwrap()
        )
        .is_err()
    );
    for case_file in [
        "invalid-cases.json",
        "resolved-invalid-cases.json",
        "inpainting-invalid-cases.json",
    ] {
        let cases = fixture(case_file);
        let base_name = cases["base_fixture"].as_str().unwrap();
        for case in cases["cases"].as_array().unwrap() {
            let mut scene = fixture(base_name);
            for operation in case["operations"].as_array().unwrap() {
                apply_operation(&mut scene, operation);
            }
            assert!(
                validate_page_scene(scene).is_err(),
                "{} must be rejected",
                case["name"]
            );
        }
    }
}

const VALID_FIXTURES: [&str; 4] = [
    "logical-valid.json",
    "resolved-valid.json",
    "overlap-preserve-valid.json",
    "inpainting-edits-valid.json",
];

/// H1 (#176): `PUT /pages/{id}/scene` is checked against the full JSON Schema before the
/// hand-written rules. The risk is a scene those rules accept and the schema refuses, so every
/// valid fixture must pass it.
#[test]
fn the_schema_accepts_every_shared_valid_fixture() {
    for name in VALID_FIXTURES {
        validate_against_schema(&fixture(name)).unwrap_or_else(|error| panic!("{name}: {error}"));
    }
}

#[test]
fn the_schema_refuses_what_it_describes() {
    let cases = fixture("inpainting-invalid-cases.json");
    let base = cases["base_fixture"].as_str().unwrap();
    let mut refused = 0;
    for case in cases["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        // The schema-shaped cases: the editor typography and the opacity range. The rest are
        // ownership and digest rules the schema cannot express.
        if !["mask-polygon", "font-", "shape-", "opacity-"]
            .iter()
            .any(|prefix| name.starts_with(prefix))
        {
            continue;
        }
        let mut scene = fixture(base);
        for operation in case["operations"].as_array().unwrap() {
            apply_operation(&mut scene, operation);
        }
        assert!(
            validate_against_schema(&scene).is_err(),
            "{name} must be refused by the schema"
        );
        refused += 1;
    }
    assert!(refused >= 10, "only {refused} schema cases ran");

    let mut extra = fixture("logical-valid.json");
    extra["unexpected"] = serde_json::json!(true);
    assert!(
        validate_against_schema(&extra).is_err(),
        "an unknown top-level field"
    );
}
