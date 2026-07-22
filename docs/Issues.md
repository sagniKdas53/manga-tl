# Issues

## Creating a series with over-rides doesn't seem to preserve the over-rides

While creating a chapter does, also the chapter card is still wrong but atlest it preserved the data inside it

See screenshots in [folder](../examples/Inheritance%20and%20creation%20issues/)

## There is a free space in the over-rides modal, add a use fallback models option

Two choices trur or false group these under advanced configurations

## Show us the provider selected because of our routing choices

It should be shown in the logs also present in the json for the project export (on that note re-validate the project and chapter export jsons)

Look in [folders](../examples/Chpater%20and%20Project%20Export/)

## The colour selector in the front-end should have more clours

Also it's transparency option doesn't work it defaults to white when clicked on the transparent option

## The chapter card has too many buttons

Move the Force export to the over flow (triple dots) menu

## Errors in export

Export Failed
Failed to generate chapter export: JDBC exception executing SQL [select l1_0.id,l1_0.created_at,l1_0.metadata_json,l1_0.page_id,l1_0.target_language,l1_0.type,l1_0.visible,l1_0.z_order from layers l1_0 left join pages p1_0 on p1_0.id=l1_0.page_id where p1_0.id=?] [ERROR: column l1_0.page_id does not exist Hint: Perhaps you meant to reference the column "l1_0.image_id". Position: 170] [n/a]; SQL [n/a]
 11:38 am
